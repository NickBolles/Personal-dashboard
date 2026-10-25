import "server-only";
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { attachmentsFor, createCapture, moveCaptureToItem } from "@/server/capture";
import { repointReports } from "@/server/ai/reports";
import type { z } from "zod";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import type { captureSchema, inboxAcceptSchema, InboxEntry, InboxResponse } from "@/lib/work";
import { unfiledConversations } from "./conversations";
import type { AssignedIssue } from "./github-rules";
import type { StoredConnection } from "./github";
import { addLink, createItem, ensureMiscellaneous } from "./store";

/**
 * The Work inbox (docs/work.md): GitHub issues assigned to you (poller and
 * webhooks), quick captures, and your unfiled conversations. Deterministic:
 * no triage model. Accept files an entry as a Work item; Dismiss hides it for
 * good (remembered, deduped by GitHub issue node id). Read-only towards GitHub.
 */

const I = schema.workInbox;
const nowIso = () => new Date().toISOString();

const toEntry = (r: typeof I.$inferSelect, extra?: CaptureExtras): InboxEntry => ({
  id: r.id,
  source: r.source as InboxEntry["source"],
  title: r.title,
  note: r.note,
  url: r.url,
  repo: r.repo,
  number: r.number,
  reason: r.reason,
  createdAt: r.createdAt,
  ...(r.source === "capture"
    ? {
        capture: {
          channel: r.channel,
          triageState: r.triageState as NonNullable<InboxEntry["capture"]>["triageState"],
          triageSkipReason: r.triageSkipReason,
          suggestedTitle: r.suggestedTitle,
          suggestedKind: r.suggestedKind,
          suggestion: extra?.suggestion ?? null,
          sensitivity: r.sensitivity as NonNullable<InboxEntry["capture"]>["sensitivity"],
          report: extra?.report ?? null,
          attachments: extra?.attachments ?? [],
          investigating: extra?.investigating ?? false,
        },
      }
    : {}),
});

type CaptureExtras = {
  suggestion: NonNullable<InboxEntry["capture"]>["suggestion"];
  report: NonNullable<InboxEntry["capture"]>["report"];
  attachments: NonNullable<InboxEntry["capture"]>["attachments"];
  investigating: boolean;
};

/** Suggestions are validated against the person's live tree when read; reports and attachments joined in. */
function captureExtras(userId: string, rows: (typeof I.$inferSelect)[]) {
  const caps = rows.filter((r) => r.source === "capture");
  const out = new Map<string, CaptureExtras>();
  if (!caps.length) return out;
  const db = getDb();
  const items = db
    .select({ id: schema.workItems.id, title: schema.workItems.title, parentId: schema.workItems.parentId, archived: schema.workItems.archived })
    .from(schema.workItems)
    .where(eq(schema.workItems.userId, userId))
    .all();
  const byId = new Map(items.map((i) => [i.id, i]));
  const pathOf = (id: string) => {
    const parts: string[] = [];
    for (let c = byId.get(id); c && parts.length < 6; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title);
    return parts.join(" › ");
  };
  const atts = attachmentsFor(caps.map((r) => r.id));
  const reportIds = caps.map((r) => r.latestReportId).filter((x): x is string => !!x);
  const reports = reportIds.length
    ? new Map(
        db
          .select({ id: schema.aiReports.id, title: schema.aiReports.title, summary: schema.aiReports.summary })
          .from(schema.aiReports)
          .where(inArray(schema.aiReports.id, reportIds))
          .all()
          .map((r) => [r.id, r]),
      )
    : new Map();
  const active = new Set(
    db
      .select({ s: schema.aiJobs.subjectId })
      .from(schema.aiJobs)
      .where(
        and(
          eq(schema.aiJobs.userId, userId),
          eq(schema.aiJobs.kind, "investigate"),
          inArray(schema.aiJobs.state, ["queued", "running", "waiting_approval", "cancelling"]),
        ),
      )
      .all()
      .map((r) => r.s),
  );
  for (const r of caps) {
    const p = r.suggestedParentId ? byId.get(r.suggestedParentId) : undefined;
    const rep = r.latestReportId ? reports.get(r.latestReportId) : undefined;
    out.set(r.id, {
      suggestion:
        p && !p.archived ? { parentId: p.id, title: p.title, path: pathOf(p.id), confidence: r.suggestionConfidence, reason: r.suggestionReason } : null,
      report: rep ? { id: rep.id, title: rep.title, summary: rep.summary.slice(0, 200) } : null,
      attachments: atts.get(r.id) ?? [],
      investigating: active.has(r.id),
    });
  }
  return out;
}

/** Waiting entries: open, neither accepted nor dismissed. Conversations are listed live from Hermes. */
function waiting(userId: string) {
  return getDb()
    .select()
    .from(I)
    .where(and(eq(I.userId, userId), eq(I.state, "open"), isNull(I.dismissedAt), isNull(I.acceptedAt), notInArray(I.source, ["conversation"])))
    .orderBy(desc(I.createdAt))
    .all();
}

export function inboxEntries(userId: string): InboxEntry[] {
  const rows = waiting(userId).slice(0, 200);
  const extras = captureExtras(userId, rows);
  return rows.map((r) => toEntry(r, extras.get(r.id)));
}

export function inboxEntry(userId: string, id: string): InboxEntry {
  const r = getDb()
    .select()
    .from(I)
    .where(and(eq(I.id, id), eq(I.userId, userId)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "Inbox entry not found");
  return toEntry(r, captureExtras(userId, [r]).get(r.id));
}

export async function getInbox(user: CurrentUser): Promise<InboxResponse> {
  const items = inboxEntries(user.id);
  if (!user.capabilities.has("hermes.chat")) return { items, conversations: [], conversationsTotal: 0, unavailable: [], count: items.length };
  const u = await unfiledConversations(user);
  return { items, conversations: u.conversations, conversationsTotal: u.total, unavailable: u.unavailable, count: items.length + u.total };
}

/**
 * Upsert the issues GitHub says are assigned to the connection's user into
 * that person's inbox (dedupe by node id). Dismissed and accepted entries stay
 * hidden; issues no longer listed (closed or unassigned) leave the inbox.
 */
export function syncAssignedIssues(conn: Pick<StoredConnection, "id" | "createdBy" | "owner">, issues: AssignedIssue[]) {
  const db = getDb();
  const at = nowIso();
  const reason = `Assigned to you on GitHub (${conn.owner})`;
  db.transaction((tx) => {
    for (const is of issues) upsertIssue(tx, conn.createdBy, conn.id, is, reason, at);
    const present = issues.map((i) => i.nodeId);
    tx.update(I)
      .set({ state: "closed", updatedAt: at })
      .where(
        and(
          eq(I.userId, conn.createdBy),
          eq(I.source, "github_issue"),
          eq(I.connectionId, conn.id),
          eq(I.state, "open"),
          ...(present.length ? [notInArray(I.externalId, present)] : []),
        ),
      )
      .run();
  });
  return issues.length;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
function upsertIssue(db: Tx | ReturnType<typeof getDb>, userId: string, connectionId: string | null, is: AssignedIssue, reason: string, at: string) {
  db.insert(I)
    .values({
      id: newId("inb"),
      userId,
      source: "github_issue",
      externalId: is.nodeId,
      connectionId,
      title: is.title,
      url: is.url,
      repo: is.repo,
      number: is.number,
      state: "open",
      reason,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [I.userId, I.source, I.externalId],
      set: { title: is.title, url: is.url, repo: is.repo, number: is.number, state: "open", connectionId, updatedAt: at },
    })
    .run();
}

/** Webhook intake for one issue: assigned and open → inbox; otherwise it leaves the inbox. */
export function applyIssueAssignment(userId: string, connectionId: string, is: AssignedIssue, assigned: boolean, open: boolean, ownerName: string) {
  const at = nowIso();
  if (assigned && open) {
    upsertIssue(getDb(), userId, connectionId, is, `Assigned to you on GitHub (${ownerName})`, at);
    return "inbox";
  }
  getDb()
    .update(I)
    .set({ state: "closed", updatedAt: at })
    .where(and(eq(I.userId, userId), eq(I.source, "github_issue"), eq(I.externalId, is.nodeId)))
    .run();
  return "removed";
}

/** The dock/inbox quick capture: a thin wrapper over the phase-5 capture path (same triage rules). */
export function capture(user: CurrentUser, body: z.infer<typeof captureSchema>, correlationId: string): InboxEntry {
  const r = createCapture(user, { text: body.text, channel: "web", investigate: body.investigate }, [], { channel: "web", correlationId });
  audit({ actor: user.id, action: "work.inbox_capture", source: "work", sourceRecord: r.entryId, result: "ok", correlationId });
  return inboxEntry(user.id, r.entryId);
}

function ownedEntry(userId: string, id: string) {
  const r = getDb()
    .select()
    .from(I)
    .where(and(eq(I.id, id), eq(I.userId, userId)))
    .get();
  if (!r || r.source === "conversation") throw new HttpError(404, "not_found", "Inbox entry not found");
  return r;
}

/** File an entry as a new thread under `parentId` (default Miscellaneous), linking the issue. */
export async function acceptEntry(user: CurrentUser, id: string, body: z.infer<typeof inboxAcceptSchema>, correlationId: string) {
  const r = ownedEntry(user.id, id);
  if (r.acceptedAt) throw new HttpError(409, "already_accepted", "Already filed");
  if (r.dismissedAt) throw new HttpError(409, "dismissed", "This was dismissed");
  // useSuggestion: the triage suggestion (validated as one of your live items) and its clean title.
  const suggested =
    body.useSuggestion && r.suggestedParentId
      ? getDb()
          .select({ id: schema.workItems.id })
          .from(schema.workItems)
          .where(and(eq(schema.workItems.id, r.suggestedParentId), eq(schema.workItems.userId, user.id), eq(schema.workItems.archived, false)))
          .get()?.id
      : undefined;
  const parentId = suggested ?? body.parentId ?? ensureMiscellaneous(user.id).id;
  const item = createItem(
    user,
    {
      kind: "thread",
      parentId,
      title: body.title ?? (body.useSuggestion && r.suggestedTitle ? r.suggestedTitle : r.title),
      summary: r.source === "capture" ? r.note : `From GitHub: ${r.repo ?? ""}#${r.number ?? ""}`,
    },
    correlationId,
  );
  if (r.source === "github_issue" && r.url)
    await addLink(
      user,
      item.id,
      { kind: "github_issue", url: r.url, title: `${r.title} (#${r.number})`.slice(0, 300), role: body.role ?? "reference" },
      correlationId,
    );
  getDb().update(I).set({ acceptedAt: nowIso(), acceptedItemId: item.id, updatedAt: nowIso() }).where(eq(I.id, id)).run();
  if (r.source === "capture") {
    // Reports and attachments move with the entry; the investigation conversation is linked as the source.
    for (const rep of repointReports(user.id, id, item.id))
      if (rep.conversationId)
        getDb()
          .insert(schema.workLinks)
          .values({
            id: newId(),
            itemId: item.id,
            kind: "chat_session",
            targetId: rep.conversationId,
            title: `✦ ${rep.title}`.slice(0, 300),
            role: "source",
            lineage: "ai_action",
          })
          .run();
    moveCaptureToItem(r, item.id);
  }
  audit({
    actor: user.id,
    action: "work.inbox_accept",
    source: "work",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { item: item.id, kind: r.source },
  });
  return { item };
}

export function dismissEntry(user: CurrentUser, id: string, correlationId: string) {
  const r = ownedEntry(user.id, id);
  if (!r.dismissedAt) getDb().update(I).set({ dismissedAt: nowIso(), updatedAt: nowIso() }).where(eq(I.id, id)).run();
  audit({ actor: user.id, action: "work.inbox_dismiss", source: "work", sourceRecord: id, result: "ok", correlationId, detail: { kind: r.source } });
  return { ok: true };
}

/** Hide an unfiled conversation from the inbox. Only its id is stored. */
export function dismissConversation(user: CurrentUser, sessionId: string, correlationId: string) {
  const at = nowIso();
  getDb()
    .insert(I)
    .values({
      id: newId("inb"),
      userId: user.id,
      source: "conversation",
      externalId: sessionId,
      state: "closed",
      dismissedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .run();
  audit({ actor: user.id, action: "work.inbox_dismiss", source: "work", result: "ok", correlationId, detail: { kind: "conversation" } });
  return { ok: true };
}
