import "server-only";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { parseAreaSettings } from "@/lib/work";
import { ACTIVE_JOB_STATES, type AiJobKind, type AiTier, type JobErrorCode, type JobState, type JobView } from "@/lib/ai";
import { getAiSettings } from "./settings";
import { canTransition, effectiveAreaPolicy, errorText, financeGuard, laneFor, tierFor, visibleFor, type AreaRef } from "./rules";
import { PROMPT_VERSIONS } from "./prompts";
import { resolveAgent, resolveAgentForNode } from "@/server/agents/routing";

/**
 * AI job store: idempotent enqueue, guarded transitions (each writes a
 * work_events row on work-item subjects and an `ai.job.<to>` audit entry with
 * no prompt or output text), cancel/retry/run-anyway, and views.
 */

const J = schema.aiJobs;
type JobRow = typeof J.$inferSelect;
const nowIso = () => new Date().toISOString();

export function toJobView(r: JobRow): JobView {
  return {
    id: r.id,
    kind: r.kind as AiJobKind,
    subjectType: r.subjectType as JobView["subjectType"],
    subjectId: r.subjectId,
    state: r.state as JobState,
    tier: r.tier as AiTier,
    model: r.model,
    attempt: r.attempt,
    estimateUsd: r.estimateUsd,
    costUsd: r.costUsd,
    costSource: r.costSource,
    errorCode: r.errorCode as JobErrorCode | null,
    errorMessage: r.errorMessage,
    conversationId: r.visibleSession ? r.hermesSessionId : null,
    reportId: r.reportId,
    budgetOverride: r.budgetOverride,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export function getJobRow(id: string) {
  return getDb().select().from(J).where(eq(J.id, id)).get();
}

export function ownedJob(userId: string, id: string) {
  const r = getJobRow(id);
  if (!r || r.userId !== userId) throw new HttpError(404, "not_found", "Job not found");
  return r;
}

/** The area (top-level item) a work item sits under, with its effective AI policy. */
export function areaOf(userId: string, itemId: string): (AreaRef & { id: string }) | null {
  const db = getDb();
  const T = schema.workItems;
  let cur = db
    .select()
    .from(T)
    .where(and(eq(T.id, itemId), eq(T.userId, userId)))
    .get();
  for (let i = 0; cur && cur.parentId && i < 50; i++) {
    const next = db
      .select()
      .from(T)
      .where(and(eq(T.id, cur.parentId), eq(T.userId, userId)))
      .get();
    if (!next) break;
    cur = next;
  }
  if (!cur) return null;
  return { id: cur.id, title: cur.title, systemKey: cur.systemKey, aiPolicy: parseAreaSettings(cur.settings).aiPolicy };
}

export function subjectText(userId: string, subjectType: string, subjectId: string): { title: string; text: string } | null {
  const db = getDb();
  // Filing suggestions: the subject is the person's own unfiled list; titles are screened one by one at enqueue.
  if (subjectType === "conversations") return subjectId === userId ? { title: "Unfiled conversations", text: "" } : null;
  if (subjectType === "work_item") {
    const r = db
      .select()
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, subjectId), eq(schema.workItems.userId, userId)))
      .get();
    return r ? { title: r.title, text: [r.title, r.summary, r.nextAction].join("\n") } : null;
  }
  const r = db
    .select()
    .from(schema.workInbox)
    .where(and(eq(schema.workInbox.id, subjectId), eq(schema.workInbox.userId, userId)))
    .get();
  return r ? { title: r.suggestedTitle ?? r.title, text: [r.title, r.note, r.url ?? ""].join("\n") } : null;
}

/** Area + guard for a subject; the area is the item's root, or for an inbox entry the item it was filed to (if any). */
export function guardSubject(userId: string, kind: AiJobKind, subjectType: string, subjectId: string, financeOverride = false) {
  const subj = subjectText(userId, subjectType, subjectId);
  if (!subj) throw new HttpError(404, "not_found", "Not found");
  let areaItem: string | null = subjectType === "work_item" ? subjectId : null;
  if (subjectType === "inbox") {
    const e = getDb().select().from(schema.workInbox).where(eq(schema.workInbox.id, subjectId)).get();
    areaItem = e?.acceptedItemId ?? null;
  }
  const area = areaItem ? areaOf(userId, areaItem) : null;
  return { subj, area, guard: financeGuard({ kind, area, text: subj.text, financeOverride }) };
}

export type EnqueueInput = {
  userId: string;
  kind: AiJobKind;
  subjectType: "work_item" | "inbox" | "conversations";
  subjectId: string;
  clientKey: string;
  params?: Record<string, unknown>;
  model?: string | null;
  budgetOverride?: boolean;
  financeOverride?: boolean;
  /** start no earlier than (ISO) */
  notBefore?: string;
  correlationId: string;
};

/** Idempotent: an identical active job (same subject + kind) is returned instead of a new one. */
export function enqueue(input: EnqueueInput): { job: JobView; created: boolean } {
  const settings = getAiSettings();
  if (!settings.enabled) throw new HttpError(409, "ai_disabled", "AI actions are turned off (Settings → AI).");
  const { area, guard } = guardSubject(input.userId, input.kind, input.subjectType, input.subjectId, input.financeOverride);
  if (!guard.ok) {
    audit({
      actor: input.userId,
      action: "ai.job.refused",
      source: "ai",
      sourceRecord: input.subjectId,
      result: "rejected",
      correlationId: input.correlationId,
      detail: { kind: input.kind, reason: guard.reason },
    });
    throw new HttpError(
      403,
      guard.reason === "area_excluded" || guard.reason === "area_triage_only" ? "ai_excluded_area" : "ai_sensitive",
      guard.reason === "area_excluded"
        ? "AI actions are off for this area."
        : guard.reason === "area_triage_only"
          ? "This area only allows capture triage."
          : guard.reason === "credentials_detected"
            ? "Not sent to AI: it looks like it contains a credential."
            : "Not sent to AI: it looks like finance.",
    );
  }
  const db = getDb();
  const active = db
    .select()
    .from(J)
    .where(
      and(
        eq(J.userId, input.userId),
        eq(J.subjectType, input.subjectType),
        eq(J.subjectId, input.subjectId),
        eq(J.kind, input.kind),
        inArray(J.state, ACTIVE_JOB_STATES as JobState[]),
      ),
    )
    .get();
  if (active) return { job: toJobView(active), created: false };
  const key = `aij:${input.subjectId}:${input.kind}:${input.clientKey}`;
  const existing = db.select().from(J).where(eq(J.idempotencyKey, key)).get();
  if (existing) return { job: toJobView(existing), created: false };
  const tier = tierFor(input.kind, { deep: input.params?.deep === true });
  const areaRow = area ? db.select().from(schema.workItems).where(eq(schema.workItems.id, area.id)).get() : undefined;
  const areaSettings = areaRow ? parseAreaSettings(areaRow.settings) : null;
  // Model: explicit per run > area default (standard tier) > tier setting. Only sent when Hermes honours per-run models.
  const model = input.model ?? (tier === "standard" ? (areaSettings?.defaultModel ?? settings.models.standard) : settings.models[tier]) ?? null;
  // Settings → Agents: the job runs on the subject's (inherited) area profile when that profile is routed.
  const agent = input.subjectType === "work_item" ? resolveAgentForNode(input.userId, input.subjectId) : resolveAgent(areaSettings?.agentMode);
  const id = newId("aij");
  const at = nowIso();
  db.insert(J)
    .values({
      id,
      userId: input.userId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      areaId: area?.id ?? null,
      state: "queued",
      lane: laneFor(input.kind),
      tier,
      model,
      /** the profile the job runs on (null = default); fixed at creation so adoption after a restart stays on it */
      hermesProfile: agent.routed ? agent.profile : null,
      visibleSession: visibleFor(input.kind),
      idempotencyKey: key,
      params: JSON.stringify(input.params ?? {}).slice(0, 4096),
      promptVersion: PROMPT_VERSIONS[input.kind],
      notBefore: input.notBefore ?? at,
      budgetOverride: !!input.budgetOverride,
      estimateUsd: settings.estimatesUsd[tier],
      createdAt: at,
      updatedAt: at,
    })
    .run();
  if (input.budgetOverride)
    audit({ actor: input.userId, action: "ai.budget_override", source: "ai", sourceRecord: id, result: "ok", correlationId: input.correlationId });
  if (input.financeOverride)
    audit({ actor: input.userId, action: "ai.finance_override", source: "ai", sourceRecord: id, result: "ok", correlationId: input.correlationId });
  audit({
    actor: input.userId,
    action: "ai.job.queued",
    source: "ai",
    sourceRecord: id,
    result: "ok",
    correlationId: input.correlationId,
    detail: { kind: input.kind, subject: input.subjectType, tier },
  });
  event(getJobRow(id)!, null, "queued");
  return { job: toJobView(getJobRow(id)!), created: true };
}

function event(r: JobRow, from: JobState | null, to: JobState) {
  if (r.subjectType !== "work_item") return;
  const exists = getDb().select({ id: schema.workItems.id }).from(schema.workItems).where(eq(schema.workItems.id, r.subjectId)).get();
  if (!exists) return;
  getDb()
    .insert(schema.workEvents)
    .values({ id: newId("wev"), itemId: r.subjectId, kind: "ai_job", fromStatus: from, toStatus: to, reason: r.kind, actor: "jarvis", source: "ai" })
    .run();
}

export type TransitionPatch = Partial<Omit<JobRow, "id" | "userId" | "state">>;

/**
 * Guarded, conditional transition (`WHERE state = from`): returns the updated
 * row, or null when another writer moved it first.
 */
export function transition(id: string, from: JobState, to: JobState, patch: TransitionPatch = {}): JobRow | null {
  if (!canTransition(from, to)) throw new Error(`illegal ai job transition ${from} → ${to}`);
  const at = nowIso();
  const terminal = ["succeeded", "failed", "cancelled", "skipped"].includes(to);
  const res = getDb()
    .update(J)
    .set({
      ...patch,
      state: to,
      updatedAt: at,
      ...(terminal ? { finishedAt: patch.finishedAt ?? at, leaseOwner: null, leaseUntil: null } : {}),
      ...(to === "queued" ? { leaseOwner: null, leaseUntil: null } : {}),
    })
    .where(and(eq(J.id, id), eq(J.state, from)))
    .run();
  if (res.changes !== 1) return null;
  const row = getJobRow(id)!;
  audit({
    actor: row.userId,
    action: `ai.job.${to}`,
    source: "ai",
    sourceRecord: id,
    result: to === "failed" ? "error" : "ok",
    correlationId: id,
    detail: { kind: row.kind, from, ...(row.errorCode && terminal ? { code: row.errorCode } : {}) },
  });
  event(row, from, to);
  return row;
}

export function failJob(row: JobRow, code: JobErrorCode, extra?: string, patch: TransitionPatch = {}) {
  return transition(row.id, row.state as JobState, "failed", { errorCode: code, errorMessage: errorText(code, extra), ...patch });
}

/** Claim up to `limit` due queued jobs of a lane (conditional update; at most 2 running work jobs per person). */
export function claimable(lane: "triage" | "work", now: Date, limit: number) {
  if (limit <= 0) return [];
  return getDb()
    .select()
    .from(J)
    .where(and(eq(J.state, "queued"), eq(J.lane, lane), lte(J.notBefore, now.toISOString())))
    .orderBy(asc(J.notBefore), asc(J.createdAt))
    .limit(limit * 4)
    .all();
}

export function runningCount(lane: "triage" | "work", userId?: string) {
  const r = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(J)
    .where(and(eq(J.lane, lane), inArray(J.state, ["running", "waiting_approval", "cancelling"]), ...(userId ? [eq(J.userId, userId)] : [])))
    .get();
  return Number(r?.n ?? 0);
}

export function claim(id: string, owner: string, now: Date, leaseMs: number) {
  const res = getDb()
    .update(J)
    .set({
      state: "running",
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      startedAt: now.toISOString(),
      attempt: sql`${J.attempt} + 1`,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(J.id, id), eq(J.state, "queued"), lte(J.notBefore, now.toISOString())))
    .run();
  if (res.changes !== 1) return null;
  const row = getJobRow(id)!;
  audit({ actor: row.userId, action: "ai.job.running", source: "ai", sourceRecord: id, result: "ok", correlationId: id, detail: { kind: row.kind } });
  event(row, "queued", "running");
  return row;
}

export function renewLease(id: string, owner: string, until: Date) {
  getDb()
    .update(J)
    .set({ leaseOwner: owner, leaseUntil: until.toISOString() })
    .where(and(eq(J.id, id), inArray(J.state, ["running", "waiting_approval", "cancelling"])))
    .run();
}

export function setIds(id: string, ids: { sessionId?: string; runId?: string }) {
  getDb()
    .update(J)
    .set({ ...(ids.sessionId ? { hermesSessionId: ids.sessionId } : {}), ...(ids.runId ? { hermesRunId: ids.runId } : {}), updatedAt: nowIso() })
    .where(eq(J.id, id))
    .run();
}

export function expiredLeases(now: Date) {
  return getDb()
    .select()
    .from(J)
    .where(and(inArray(J.state, ["running", "waiting_approval", "cancelling"]), lte(J.leaseUntil, now.toISOString())))
    .all();
}

export function activeCount() {
  const r = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(J)
    .where(inArray(J.state, ["queued", "running", "waiting_approval", "cancelling"]))
    .get();
  return Number(r?.n ?? 0);
}

export function listJobs(userId: string, q: { state?: string; subject?: string; limit?: number } = {}) {
  return getDb()
    .select()
    .from(J)
    .where(and(eq(J.userId, userId), ...(q.state ? [eq(J.state, q.state)] : []), ...(q.subject ? [eq(J.subjectId, q.subject)] : [])))
    .orderBy(desc(J.createdAt))
    .limit(Math.min(200, q.limit ?? 50))
    .all()
    .map(toJobView);
}

/** Queued/blocked jobs cancel at once; running ones go to `cancelling` and end `cancelled` only after Hermes confirms. */
export function requestCancel(userId: string, id: string, correlationId: string) {
  const r = ownedJob(userId, id);
  const at = nowIso();
  let out: JobRow | null = null;
  if (r.state === "queued" || r.state === "budget_blocked")
    out = transition(id, r.state, "cancelled", { errorCode: "cancelled", errorMessage: errorText("cancelled"), cancelRequestedAt: at });
  else if (r.state === "running" || r.state === "waiting_approval") out = transition(id, r.state, "cancelling", { cancelRequestedAt: at });
  audit({ actor: userId, action: "ai.job.cancel_requested", source: "ai", sourceRecord: id, result: "ok", correlationId });
  return toJobView(out ?? getJobRow(id)!);
}

export function retryJob(userId: string, id: string, budgetOverride: boolean | undefined, correlationId: string) {
  const r = ownedJob(userId, id);
  if (!["failed", "cancelled", "skipped", "succeeded"].includes(r.state)) throw new HttpError(409, "job_active", "That job is still active");
  const params = { ...(JSON.parse(r.params || "{}") as Record<string, unknown>), retryOf: r.id };
  return enqueue({
    userId,
    kind: r.kind as AiJobKind,
    subjectType: r.subjectType as "work_item" | "inbox",
    subjectId: r.subjectId,
    clientKey: newId("rt").replace(/[^A-Za-z0-9_-]/g, ""),
    params,
    model: r.model,
    budgetOverride,
    correlationId,
  });
}

export function runAnyway(userId: string, id: string, correlationId: string) {
  const r = ownedJob(userId, id);
  if (r.state !== "budget_blocked") throw new HttpError(409, "not_blocked", "That job isn't waiting for budget");
  const out = transition(id, "budget_blocked", "queued", { budgetOverride: true, notBefore: nowIso() });
  audit({ actor: userId, action: "ai.budget_override", source: "ai", sourceRecord: id, result: "ok", correlationId });
  return toJobView(out ?? getJobRow(id)!);
}

/** Budget-blocked jobs return to the queue on a new local day. */
export function releaseBudgetBlocked(blockedBefore: string) {
  const rows = getDb()
    .select()
    .from(J)
    .where(and(eq(J.state, "budget_blocked"), lte(J.updatedAt, blockedBefore)))
    .all();
  for (const r of rows) transition(r.id, "budget_blocked", "queued", { notBefore: nowIso() });
  return rows.length;
}

export function areaPolicyFor(userId: string, itemId: string) {
  return effectiveAreaPolicy(areaOf(userId, itemId));
}
