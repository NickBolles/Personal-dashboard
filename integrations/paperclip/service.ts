import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { newId, sha256 } from "@/server/crypto";
import { config } from "@/server/config";
import { HttpError } from "@/server/http/errors";
import type { EntityLink, EntityLinkRelationship, NextAction } from "@/lib/contracts";
import { iso, MINUTE } from "@/lib/time";
import { runChecks } from "@/integrations/testing";
import { baseAction } from "@/integrations/actions";
import type { SourceAdapter } from "@/integrations/types";
import {
  issueUrl,
  PaperclipClient,
  paperclipConn,
  resolveCompany,
  TERMINAL,
  type PaperclipIssue,
} from "./client";

const STALE = 10 * MINUTE;
const PRIORITY = ["critical", "high", "medium", "low"];

export type IssueCard = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority?: string;
  owner?: string;
  url: string;
};

export type InitiativeCard = IssueCard & {
  progress: { done: number; total: number };
  blockers: (IssueCard & { blockedBy: IssueCard[] })[];
  nextChild?: IssueCard;
  children: IssueCard[];
  relatedSessions: { sessionId: string; relationship: string; linkId: string }[];
};

function card(c: ReturnType<typeof paperclipConn>, prefix: string | undefined, i: Pick<PaperclipIssue, "id" | "identifier" | "title" | "status" | "priority" | "assigneeAgentId" | "assigneeUserId">): IssueCard {
  return {
    id: i.id,
    identifier: i.identifier ?? i.id.slice(0, 8),
    title: i.title,
    status: i.status,
    priority: i.priority ?? undefined,
    owner: i.assigneeUserId ? `user:${i.assigneeUserId}` : i.assigneeAgentId ? `agent:${i.assigneeAgentId}` : undefined,
    url: issueUrl(c, prefix, i),
  };
}

function byPriority(a: PaperclipIssue, b: PaperclipIssue) {
  const p = PRIORITY.indexOf(a.priority ?? "medium") - PRIORITY.indexOf(b.priority ?? "medium");
  if (p) return p;
  return (a.issueNumber ?? 0) - (b.issueNumber ?? 0);
}

function linksForTargets(ids: string[]) {
  if (!ids.length) return [];
  return getDb()
    .select()
    .from(schema.entityLinks)
    .where(and(eq(schema.entityLinks.targetSystem, "paperclip"), inArray(schema.entityLinks.targetId, ids)))
    .all();
}

/** Build an initiative card entirely from Paperclip data (progress from children only). */
export async function initiativeCard(issue: PaperclipIssue): Promise<InitiativeCard> {
  const c = paperclipConn();
  const company = await resolveCompany(c);
  const children = (await PaperclipClient.issues(c, { parentId: issue.id })).filter((x) => x.status !== "cancelled");
  const done = children.filter((x) => x.status === "done").length;
  const blockers = children
    .filter((x) => x.status === "blocked" || (x.blockedBy ?? []).some((b) => !TERMINAL.includes(b.status)))
    .map((x) => ({
      ...card(c, company.prefix, x),
      blockedBy: (x.blockedBy ?? []).filter((b) => !TERMINAL.includes(b.status)).map((b) => card(c, company.prefix, b)),
    }));
  const blockedIds = new Set(blockers.map((b) => b.id));
  const next = children
    .filter((x) => ["todo", "in_progress", "in_review", "backlog"].includes(x.status) && !blockedIds.has(x.id))
    .sort((a, b) => {
      const order = ["in_progress", "in_review", "todo", "backlog"];
      return order.indexOf(a.status) - order.indexOf(b.status) || byPriority(a, b);
    })[0];
  const links = linksForTargets([issue.id, ...children.map((x) => x.id)]).filter((l) => l.sourceType === "hermes_session");
  return {
    ...card(c, company.prefix, issue),
    progress: { done, total: children.length },
    blockers,
    nextChild: next ? card(c, company.prefix, next) : undefined,
    children: children.sort(byPriority).map((x) => card(c, company.prefix, x)),
    relatedSessions: links.map((l) => ({ sessionId: l.sourceId, relationship: l.relationship, linkId: l.id })),
  };
}

export async function listInitiatives() {
  const c = paperclipConn();
  const company = await resolveCompany(c);
  const open = await PaperclipClient.issues(c, { status: ["backlog", "todo", "in_progress", "in_review", "blocked"] });
  const parentIds = new Set(open.map((i) => i.parentId).filter(Boolean) as string[]);
  const linkedIds = new Set(
    getDb()
      .select({ id: schema.entityLinks.targetId })
      .from(schema.entityLinks)
      .where(eq(schema.entityLinks.targetSystem, "paperclip"))
      .all()
      .map((r) => r.id),
  );
  const topLevel = open.filter((i) => !i.parentId && (parentIds.has(i.id) || linkedIds.has(i.id)));
  const cards = await Promise.all(topLevel.sort(byPriority).slice(0, 12).map(initiativeCard));
  const mine = (await PaperclipClient.issues(c, { status: ["todo", "in_progress", "in_review", "blocked"], assignee: "me" })).sort(byPriority);
  return {
    initiatives: cards,
    myWork: mine.map((i) => card(c, company.prefix, i)),
    paperclipUrl: company.prefix ? `${c.uiUrl}/${company.prefix}` : c.uiUrl,
  };
}

export async function searchIssues(q: string) {
  const c = paperclipConn();
  const company = await resolveCompany(c);
  const list = await PaperclipClient.issues(c, { q, limit: 20 });
  return list.map((i) => ({ ...card(c, company.prefix, i), parentId: i.parentId ?? undefined }));
}

export function linksForSession(sessionId: string): EntityLink[] {
  return getDb()
    .select()
    .from(schema.entityLinks)
    .where(and(eq(schema.entityLinks.sourceType, "hermes_session"), eq(schema.entityLinks.sourceId, sessionId)))
    .all() as EntityLink[];
}

export function createLink(input: {
  sourceType: EntityLink["sourceType"];
  sourceId: string;
  issue: Pick<PaperclipIssue, "id" | "identifier" | "title">;
  relationship: EntityLinkRelationship;
  createdBy: "user" | "agent";
}) {
  const row = {
    id: newId("lnk"),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetSystem: "paperclip",
    targetType: "issue",
    targetId: input.issue.id,
    targetIdentifier: input.issue.identifier ?? input.issue.id.slice(0, 8),
    targetTitle: input.issue.title,
    relationship: input.relationship,
    createdBy: input.createdBy,
  };
  getDb().insert(schema.entityLinks).values(row).onConflictDoNothing().run();
  return getDb()
    .select()
    .from(schema.entityLinks)
    .where(
      and(
        eq(schema.entityLinks.sourceType, row.sourceType),
        eq(schema.entityLinks.sourceId, row.sourceId),
        eq(schema.entityLinks.targetId, row.targetId),
        eq(schema.entityLinks.relationship, row.relationship),
      ),
    )
    .get() as EntityLink;
}

/** Unlinking only removes Jarvis' relationship record — never closes or deletes Paperclip work. */
export function deleteLink(id: string, actor: string, correlationId: string) {
  const res = getDb().delete(schema.entityLinks).where(eq(schema.entityLinks.id, id)).run();
  if (!res.changes) throw new HttpError(404, "not_found", "Link not found");
  audit({ actor, action: "paperclip.unlink", source: "paperclip", sourceRecord: id, result: "ok", correlationId });
}

export type TrackRequest =
  | { mode: "link"; sessionId: string; issueId: string; relationship?: EntityLinkRelationship }
  | { mode: "create"; sessionId: string; title: string; description?: string }
  | { mode: "child"; sessionId: string; parentId: string; title: string; description?: string };

/** Deterministic idempotency key so retries and other conversations reuse the same issue. */
export function trackIdempotencyKey(r: { title: string; parentId?: string }) {
  return `jarvis:${sha256(`${(r.parentId ?? "root").toLowerCase()}|${r.title.trim().toLowerCase()}`).slice(0, 40)}`;
}

export async function track(r: TrackRequest, actor: string, correlationId: string) {
  const c = paperclipConn();
  let issue: PaperclipIssue;
  let created = false;
  if (r.mode === "link") {
    issue = await PaperclipClient.issue(c, r.issueId);
  } else {
    const parentId = r.mode === "child" ? (await PaperclipClient.issue(c, r.parentId)).id : undefined;
    const backlink = config.publicOrigin ? `${config.publicOrigin}/chat/${encodeURIComponent(r.sessionId)}` : `Hermes session ${r.sessionId}`;
    issue = await PaperclipClient.createIssue(c, {
      title: r.title.trim(),
      description: [r.description?.trim(), `Originated from Jarvis conversation: ${backlink}`].filter(Boolean).join("\n\n"),
      parentId,
      idempotencyKey: trackIdempotencyKey({ title: r.title, parentId }),
    });
    created = !issue.deduplicated;
  }
  const link = createLink({
    sourceType: "hermes_session",
    sourceId: r.sessionId,
    issue,
    relationship: r.mode === "link" ? (r.relationship ?? "related_to") : "originated_from",
    createdBy: "user",
  });
  audit({
    actor,
    action: `paperclip.track.${r.mode}`,
    source: "paperclip",
    sourceRecord: issue.id,
    result: "ok",
    correlationId,
    detail: { sessionId: r.sessionId, identifier: issue.identifier, created },
  });
  const company = await resolveCompany(c);
  return { link, issue: card(c, company.prefix, issue), created, deduplicated: Boolean(issue.deduplicated) };
}

export const paperclipAdapter: SourceAdapter = {
  source: "paperclip",
  staleAfterMs: STALE,
  async fetch(ctx) {
    const c = paperclipConn();
    const company = await resolveCompany(c);
    const mine = await PaperclipClient.issues(c, { status: ["in_review", "todo", "in_progress", "blocked"], assignee: "me" });
    const actions: NextAction[] = mine
      .filter((i) => i.status === "in_review" || i.priority === "critical")
      .map((i) =>
        baseAction("paperclip", i.id, ctx, STALE, {
          title: `${i.identifier ?? ""} ${i.title}`.trim(),
          detail: i.status === "in_review" ? "Waiting for your review in Paperclip" : `Critical · ${i.status.replace("_", " ")}`,
          status: "open",
          priorityReason: i.status === "in_review" ? "awaiting_user" : "today",
          updatedAt: i.updatedAt ?? iso(ctx.now),
          href: issueUrl(c, company.prefix, i),
          external: true,
          primaryAction: { kind: "open", label: "Open in Paperclip" },
        }),
      );
    return { actions };
  },
  async test() {
    let companies: { id: string; name: string }[] = [];
    return runChecks(
      [
        {
          name: "Authenticate",
          run: async () => {
            const me = await PaperclipClient.me(paperclipConn()).catch(() => null);
            return me?.user?.name ? `Signed in as ${me.user.name}` : "API key accepted";
          },
        },
        {
          name: "List companies",
          run: async () => {
            companies = await PaperclipClient.companies(paperclipConn());
            if (!companies.length) throw new Error("No accessible companies");
            return companies.map((x) => x.name).join(", ");
          },
        },
        {
          name: "Read issues",
          run: async () => {
            const list = await PaperclipClient.issues(paperclipConn(), { limit: 5 });
            return `Read ${list.length} issues`;
          },
        },
      ],
      () => [{ field: "companyId", label: "Company", options: companies.map((x) => ({ value: x.id, label: x.name })) }],
    );
  },
};
