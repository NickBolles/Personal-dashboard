import "server-only";
import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId, getKey } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { createItem, getDetail } from "@/server/work/store";
import type { AiJobKind, ReportApply, ReportSource, ReportView, ScheduleSlot } from "@/lib/ai";
import { AI_KIND_LABEL } from "@/lib/ai";

/**
 * Reports: validated model output → ai_reports + ai_report_sources (one
 * transaction), the visible conversation linked as evidence (lineage
 * ai_action), views, read/pin/archive/feedback, export and "apply" actions.
 * Applying is always local and explicit; plan children are one undoable op.
 */

const R = schema.aiReports;
const S = schema.aiReportSources;
const nowIso = () => new Date().toISOString();

// --- URL hygiene ---

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|.*\.lan|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

/** http(s) only; no credentials, no internal hosts. Returns the normalised URL or null. */
export function safeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (PRIVATE_HOST.test(u.hostname)) return null;
  u.hash = u.hash.slice(0, 200);
  return u.toString();
}

export function normaliseSources(list: { url: string; title?: string; quote?: string }[] | undefined) {
  const out: { kind: string; url: string; title: string; quote: string | null }[] = [];
  const seen = new Set<string>();
  for (const s of list ?? []) {
    const url = safeSourceUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const host = new URL(url).hostname;
    out.push({
      kind: /(^|\.)github\.com$/.test(host) ? "github" : "web",
      url,
      title: (s.title || host).slice(0, 300),
      quote: s.quote ? s.quote.slice(0, 300) : null,
    });
    if (out.length >= 25) break;
  }
  return out;
}

type ReportRow = typeof R.$inferSelect;

export function toReportView(r: ReportRow, sources?: ReportSource[]): ReportView {
  const count = sources?.length ?? getDb().select({ idx: S.idx }).from(S).where(eq(S.reportId, r.id)).all().length;
  return {
    id: r.id,
    jobId: r.jobId,
    kind: r.kind as AiJobKind,
    subjectType: r.subjectType as ReportView["subjectType"],
    subjectId: r.subjectId,
    title: r.title,
    summary: r.summary,
    bodyMd: r.bodyMd,
    structured: safeJson(r.structured),
    confidence: r.confidence as ReportView["confidence"],
    model: r.model,
    costUsd: r.costUsd,
    conversationId: r.conversationId,
    readAt: r.readAt,
    pinnedAt: r.pinnedAt,
    archivedAt: r.archivedAt,
    feedback: r.feedback ? (safeJson(r.feedback) as ReportView["feedback"]) : null,
    supersededBy: r.supersededBy,
    createdAt: r.createdAt,
    sourceCount: count,
    ...(sources ? { sources } : {}),
  };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type ReportDraft = {
  title: string;
  summary: string;
  bodyMd: string;
  structured: Record<string, unknown>;
  confidence: "low" | "medium" | "high";
  sources: { url: string; title?: string; quote?: string }[];
};

/** Common fields from a validated model answer; research/investigate with 0 working sources are forced to low confidence. */
export function draftFromOutput(kind: AiJobKind, out: Record<string, unknown>): ReportDraft {
  const { title, summary, body_markdown, sources, confidence, ...rest } = out as {
    title?: string;
    summary?: string;
    body_markdown?: string;
    sources?: { url: string; title?: string; quote?: string }[];
    confidence?: "low" | "medium" | "high";
  } & Record<string, unknown>;
  const clean = normaliseSources(sources);
  let conf = confidence ?? "medium";
  if ((kind === "research" || kind === "investigate") && clean.length === 0) conf = "low";
  return {
    title: (title || AI_KIND_LABEL[kind]).slice(0, 120),
    summary: (summary ?? "").slice(0, 600),
    bodyMd: (body_markdown ?? "").slice(0, 20_000),
    structured: rest,
    confidence: conf,
    sources: sources ?? [],
  };
}

export function writeReport(job: typeof schema.aiJobs.$inferSelect, d: ReportDraft, extra: { costUsd: number | null }) {
  const id = newId("air");
  const db = getDb();
  const clean = normaliseSources(d.sources);
  db.transaction((tx) => {
    tx.insert(R)
      .values({
        id,
        userId: job.userId,
        jobId: job.id,
        kind: job.kind,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        originInboxId: job.subjectType === "inbox" ? job.subjectId : null,
        title: d.title,
        summary: d.summary,
        bodyMd: d.bodyMd,
        structured: JSON.stringify(d.structured),
        confidence: d.confidence,
        model: job.model,
        promptVersion: job.promptVersion,
        costUsd: extra.costUsd,
        conversationId: job.visibleSession ? job.hermesSessionId : null,
        createdAt: nowIso(),
      })
      .run();
    clean.forEach((s, idx) => tx.insert(S).values({ reportId: id, idx, kind: s.kind, url: s.url, title: s.title, quote: s.quote, accessedAt: nowIso() }).run());
    // Re-runs supersede earlier reports of the same kind (kept, collapsible).
    tx.update(R)
      .set({ supersededBy: id })
      .where(and(eq(R.userId, job.userId), eq(R.subjectId, job.subjectId), eq(R.kind, job.kind), ne(R.id, id), isNull(R.supersededBy)))
      .run();
    if (job.subjectType === "inbox")
      tx.update(schema.workInbox).set({ latestReportId: id, updatedAt: nowIso() }).where(eq(schema.workInbox.id, job.subjectId)).run();
  });
  return id;
}

/** File the visible conversation under the item (evidence, lineage ai_action) and record the person as its owner. */
export function linkConversation(job: typeof schema.aiJobs.$inferSelect, itemId: string, title: string) {
  if (!job.hermesSessionId) return;
  const db = getDb();
  db.insert(schema.sessionMeta).values({ sessionId: job.hermesSessionId, userId: job.userId }).onConflictDoNothing().run();
  const L = schema.workLinks;
  const dup = db
    .select({ id: L.id })
    .from(L)
    .where(and(eq(L.itemId, itemId), eq(L.kind, "chat_session"), eq(L.targetId, job.hermesSessionId)))
    .get();
  if (dup) return;
  db.insert(L)
    .values({ id: newId(), itemId, kind: "chat_session", targetId: job.hermesSessionId, title: title.slice(0, 300), role: "evidence", lineage: "ai_action" })
    .run();
}

export function reportSources(id: string): ReportSource[] {
  return getDb()
    .select()
    .from(S)
    .where(eq(S.reportId, id))
    .orderBy(S.idx)
    .all()
    .map((s) => ({ idx: s.idx, kind: s.kind, url: s.url, title: s.title, quote: s.quote }));
}

export function ownedReport(userId: string, id: string) {
  const r = getDb().select().from(R).where(eq(R.id, id)).get();
  if (!r || r.userId !== userId) throw new HttpError(404, "not_found", "Report not found");
  return r;
}

export function getReport(userId: string, id: string) {
  const r = ownedReport(userId, id);
  return toReportView(r, reportSources(id));
}

export function listReports(userId: string, q: { subjectId?: string; unread?: boolean; limit?: number; includeArchived?: boolean } = {}) {
  return getDb()
    .select()
    .from(R)
    .where(
      and(
        eq(R.userId, userId),
        ...(q.subjectId ? [eq(R.subjectId, q.subjectId)] : []),
        ...(q.unread ? [isNull(R.readAt), isNull(R.supersededBy)] : []),
        ...(q.includeArchived ? [] : [isNull(R.archivedAt)]),
      ),
    )
    .orderBy(desc(R.createdAt))
    .limit(Math.min(100, q.limit ?? 30))
    .all()
    .map((r) => toReportView(r));
}

export function patchReport(
  userId: string,
  id: string,
  p: { read?: boolean; pinned?: boolean; archived?: boolean; feedback?: { value: string; note?: string } },
) {
  ownedReport(userId, id);
  const at = nowIso();
  getDb()
    .update(R)
    .set({
      ...(p.read !== undefined ? { readAt: p.read ? at : null } : {}),
      ...(p.pinned !== undefined ? { pinnedAt: p.pinned ? at : null } : {}),
      ...(p.archived !== undefined ? { archivedAt: p.archived ? at : null } : {}),
      ...(p.feedback ? { feedback: JSON.stringify(p.feedback) } : {}),
    })
    .where(eq(R.id, id))
    .run();
  return getReport(userId, id);
}

export function exportReport(userId: string, id: string, format: "md" | "json") {
  const r = getReport(userId, id);
  if (format === "json") return { body: JSON.stringify(r, null, 2), type: "application/json", ext: "json" };
  const src = (r.sources ?? []).map((s) => `${s.idx + 1}. [${s.title.replace(/[[\]]/g, "")}](${s.url})${s.quote ? ` — “${s.quote}”` : ""}`);
  const st = r.structured as { next_actions?: { title: string; why?: string }[]; open_questions?: string[]; assumptions?: string[] };
  const md = [
    `# ${r.title}`,
    `*${AI_KIND_LABEL[r.kind]} · ${r.createdAt} · ${r.model ?? "default model"} · confidence ${r.confidence}*`,
    "",
    r.summary,
    "",
    r.bodyMd,
    st.next_actions?.length ? `\n## Next actions\n${st.next_actions.map((n) => `- ${n.title}${n.why ? ` — ${n.why}` : ""}`).join("\n")}` : "",
    st.open_questions?.length ? `\n## Open questions\n${st.open_questions.map((q) => `- ${q}`).join("\n")}` : "",
    st.assumptions?.length ? `\n## Assumptions\n${st.assumptions.map((q) => `- ${q}`).join("\n")}` : "",
    src.length ? `\n## Sources\n${src.join("\n")}` : "",
  ].join("\n");
  return { body: md, type: "text/markdown; charset=utf-8", ext: "md" };
}

// --- Apply (spec §7) ---

function confirmToken(userId: string, preview: object, exp: number) {
  const mac = crypto
    .createHmac("sha256", getKey())
    .update(`${userId}:${exp}:${JSON.stringify(preview)}`)
    .digest("base64url");
  return `${exp}.${mac}`;
}

export async function applyReport(user: CurrentUser, id: string, a: ReportApply, correlationId: string) {
  const r = ownedReport(user.id, id);
  if (r.subjectType !== "work_item") throw new HttpError(409, "file_first", "File the capture as an item first");
  const itemId = r.subjectId;
  getDetail(user.id, itemId); // ownership
  const st = safeJson(r.structured) as {
    next_actions?: { title: string }[];
    steps?: { title: string; detail?: string; dependsOn?: number[] }[];
    slots?: ScheduleSlot[];
  };
  const db = getDb();
  const T = schema.workItems;
  const done = (detail: Record<string, unknown>) =>
    audit({ actor: user.id, action: "ai.report.apply", source: "ai", sourceRecord: id, result: "ok", correlationId, detail: { what: a.what, ...detail } });
  if (a.what === "next_action") {
    const n = st.next_actions?.[a.index];
    if (!n) throw new HttpError(400, "bad_index", "No such next action");
    db.update(T)
      .set({ nextAction: n.title.slice(0, 500), updatedAt: nowIso() })
      .where(eq(T.id, itemId))
      .run();
    db.insert(schema.workEvents)
      .values({ id: newId(), itemId, kind: "edit", reason: `Next action from report “${r.title}”`.slice(0, 300), actor: user.id, source: "ai" })
      .run();
    done({ index: a.index });
    return { item: getDetail(user.id, itemId).item, op: null };
  }
  if (a.what === "plan_children") {
    const steps = st.steps ?? [];
    const pick = (a.indexes?.length ? a.indexes : steps.map((_, i) => i)).filter((i) => steps[i]);
    if (!pick.length) throw new HttpError(400, "bad_index", "No plan steps to create");
    const created = new Map<number, string>();
    for (const i of pick) {
      const s = steps[i]!;
      const child = createItem(
        user,
        { kind: "thread", parentId: itemId, title: s.title.slice(0, 200), summary: (s.detail ?? "").slice(0, 2000) },
        correlationId,
      );
      created.set(i, child.id);
    }
    // dependsOn may only point at earlier steps, so the new edges can't form a cycle.
    for (const [i, childId] of created)
      for (const dep of steps[i]!.dependsOn ?? [])
        if (dep < i && created.has(dep))
          db.insert(schema.workDependencies)
            .values({ id: newId(), userId: user.id, itemId: childId, dependsOnId: created.get(dep)! })
            .onConflictDoNothing()
            .run();
    const opId = newId("op");
    db.insert(schema.workOps)
      .values({
        id: opId,
        userId: user.id,
        itemId,
        kind: "ai_plan_create",
        payload: JSON.stringify({ childIds: [...created.values()], reportId: id }),
        createdAt: nowIso(),
      })
      .run();
    done({ count: created.size });
    return { item: getDetail(user.id, itemId).item, op: { id: opId, kind: "ai_plan_create", label: `Created ${created.size} child items` } };
  }
  const slot = st.slots?.[a.slot];
  if (!slot) throw new HttpError(400, "bad_index", "No such slot");
  if (a.what === "dates") {
    const day = slot.start.slice(0, 10);
    db.update(T)
      .set({ startDate: day, targetDate: slot.end.slice(0, 10), updatedAt: nowIso() })
      .where(eq(T.id, itemId))
      .run();
    db.insert(schema.workEvents)
      .values({
        id: newId(),
        itemId,
        kind: "dates",
        reason: `Dates from “Suggest a time” (${slot.start} → ${slot.end})`.slice(0, 300),
        actor: user.id,
        source: "ai",
      })
      .run();
    done({ slot: a.slot });
    return { item: getDetail(user.id, itemId).item, op: null };
  }
  // calendar_event: owner decision — calendar writes stay OFF in phase 5 (ai.schedule.calendarWrite.enabled=false).
  const { getAiSettings } = await import("./settings");
  const cw = getAiSettings().schedule.calendarWrite;
  if (!cw.enabled || !cw.entityId) throw new HttpError(409, "calendar_write_disabled", "Calendar writes are turned off");
  const preview = { entityId: cw.entityId, summary: getDetail(user.id, itemId).item.title.slice(0, 200), start: slot.start, end: slot.end };
  if (!a.confirmToken) {
    const exp = Date.now() + 5 * 60_000;
    throw Object.assign(new HttpError(409, "confirm_required", "Confirm the calendar event"), { preview, confirmToken: confirmToken(user.id, preview, exp) });
  }
  const [expS] = a.confirmToken.split(".");
  const exp = Number(expS);
  if (!exp || exp < Date.now() || confirmToken(user.id, preview, exp) !== a.confirmToken)
    throw new HttpError(409, "confirm_expired", "Confirmation expired; try again");
  // Not reachable while the flag is off; the HA write + readback path is implemented when the owner enables it.
  throw new HttpError(501, "not_enabled", "Calendar writes aren't available in this build");
}

/** Undo for ai_plan_create: untouched children are deleted, the rest archived (called from undoOp). */
export function childIdsOfPlanOp(payload: string): string[] {
  try {
    const p = JSON.parse(payload) as { childIds?: unknown };
    return Array.isArray(p.childIds) ? p.childIds.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Re-point an inbox entry's reports to the item it was filed as (spec §4.2). */
export function repointReports(userId: string, inboxId: string, itemId: string) {
  getDb()
    .update(R)
    .set({ subjectType: "work_item", subjectId: itemId })
    .where(and(eq(R.userId, userId), eq(R.subjectType, "inbox"), eq(R.subjectId, inboxId)))
    .run();
  return getDb()
    .select({ conversationId: R.conversationId, kind: R.kind, title: R.title })
    .from(R)
    .where(and(eq(R.userId, userId), eq(R.originInboxId, inboxId), inArray(R.kind, ["investigate", "research"])))
    .all();
}
