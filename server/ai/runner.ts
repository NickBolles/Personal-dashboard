import "server-only";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { userById } from "@/server/auth";
import { getPreferences } from "@/server/settings";
import { processSingleton } from "@/server/singleton";
import { notify } from "@/server/notifications";
import { kickDispatcher } from "@/server/notifications/dispatcher";
import { isConfigured } from "@/integrations/store";
import { HermesTaskError, readCost, runHermesTask, takeLastCost } from "@/integrations/hermes/jobs";
import { hermesConn } from "@/integrations/hermes/client";
import { AI_KIND_LABEL, KIND_VERB, OUTPUT_SCHEMAS, type AiJobKind, type JobErrorCode, type JobState } from "@/lib/ai";
import type { ContextSource } from "@/lib/work";
import { getAiSettings } from "./settings";
import { spendToday } from "./budget";
import { inboxContext, itemContext, triageDestinations } from "./context";
import { instructionsFor, taskFor } from "./prompts";
import { draftFromOutput, linkConversation, writeReport } from "./reports";
import {
  backoffMs,
  budgetGate,
  effectiveAreaPolicy,
  errorText,
  financeGuard,
  localDay,
  localDayStart,
  overCap,
  reportBucket,
  retryable,
  shouldInvestigate,
} from "./rules";
import { parseAreaSettings } from "@/lib/work";
import {
  activeCount,
  claim,
  claimable,
  enqueue,
  expiredLeases,
  failJob,
  getJobRow,
  guardSubject,
  releaseBudgetBlocked,
  renewLease,
  runningCount,
  setIds,
  transition,
} from "./jobs";
import { scheduleSlotsFor } from "./schedule-data";

/**
 * The AI job runner (spec §3.2): a self-contained scheduler like the GitHub
 * poller, independent of JARVIS_DISABLE_WORKER. Armed only while
 * `ai.enabled` and Hermes is configured. Each tick reconciles leases, adopts
 * orphaned runs by run id (never re-starts them), claims queued jobs per lane
 * up to the concurrency setting (budget gate at claim time) and executes them
 * without blocking the tick. Never throws.
 */

type Inflight = { controller: AbortController; promise: Promise<void> };
type RunnerState = {
  timer: NodeJS.Timeout | null;
  armed: boolean;
  ticking: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  inflight: Map<string, Inflight>;
  bootId: string;
  lastDay: string | null;
};
const state = () =>
  processSingleton<RunnerState>("ai_runner", () => ({
    timer: null,
    armed: false,
    ticking: false,
    lastTickAt: null,
    lastError: null,
    inflight: new Map(),
    bootId: Math.random().toString(36).slice(2, 10),
    lastDay: null,
  }));

const LEASE_MS = 90_000;
const owner = () => `${process.pid}:${state().bootId}`;
const J = schema.aiJobs;

export function runnerConfigured() {
  try {
    return getAiSettings().enabled && isConfigured("hermes");
  } catch {
    return false;
  }
}

/** One tick (exported for tests). Never throws. */
export async function runnerTick(now = new Date()) {
  const s = state();
  const settings = getAiSettings();
  const tz = getPreferences().timezone;
  const day = localDay(now, tz);
  try {
    // New local day (or first tick after a restart): jobs blocked before today go back to the queue.
    if (s.lastDay !== day) releaseBudgetBlocked(localDayStart(now, tz).toISOString());
    s.lastDay = day;

    // 1. Our own in-flight jobs: renew leases; propagate cancel requests.
    maintainInflight(now);
    // 2. Expired leases (crash/restart): adopt by run id, requeue, or fail.
    for (const row of expiredLeases(now)) {
      if (s.inflight.has(row.id)) continue;
      if (row.hermesRunId) {
        renewLease(row.id, owner(), new Date(now.getTime() + LEASE_MS));
        launch(row.id, true);
      } else if (row.state === "cancelling") {
        transition(row.id, "cancelling", "cancelled", { errorCode: "cancelled", errorMessage: errorText("cancelled") });
      } else if (row.attempt < row.maxAttempts) {
        transition(row.id, row.state as JobState, "queued", { notBefore: now.toISOString() });
      } else failJob(row, "upstream", "lost after a restart");
    }
    // 3. Claim per lane.
    for (const lane of ["triage", "work"] as const) {
      let free = settings.concurrency[lane] - runningCount(lane);
      for (const cand of claimable(lane, now, Math.max(0, free))) {
        if (free <= 0) break;
        if (lane === "work" && runningCount("work", cand.userId) >= 2) continue;
        const spend = spendToday(now);
        const gate = budgetGate({
          spentToday: spend.spentUsd,
          reserved: spend.reservedUsd,
          estimate: cand.estimateUsd,
          daily: settings.dailyBudgetUsd,
          override: cand.budgetOverride,
        });
        if (!gate.ok) {
          if (transition(cand.id, "queued", "budget_blocked")) {
            notify(
              {
                type: "ai.budget",
                category: "info",
                severity: "info",
                title: `AI budget reached ($${settings.dailyBudgetUsd.toFixed(2)})`,
                body: "New jobs wait until tomorrow, or open one and choose Run anyway.",
                source: "work",
                deepLink: "/settings/ai",
                dedupeKey: `ai:budget:${day}`,
              },
              cand.userId,
            );
            if (cand.subjectType === "inbox") setTriage(cand.subjectId, cand.kind, "skipped", "budget");
          }
          continue;
        }
        const claimed = claim(cand.id, owner(), now, LEASE_MS);
        if (!claimed) continue;
        free--;
        launch(claimed.id, false);
      }
    }
    s.lastError = null;
  } catch (e) {
    s.lastError = (e as Error).message.slice(0, 200);
  }
  s.lastTickAt = now.getTime();
}

/** Renew our leases and propagate cancel requests to in-flight runs (also while AI is disabled). */
function maintainInflight(now = new Date()) {
  for (const [id, f] of state().inflight) {
    const row = getJobRow(id);
    if (!row) continue;
    renewLease(id, owner(), new Date(now.getTime() + LEASE_MS));
    if (row.state === "cancelling" && !f.controller.signal.aborted) f.controller.abort();
  }
}

function launch(id: string, adopt: boolean) {
  const s = state();
  const controller = new AbortController();
  const row = getJobRow(id);
  if (row?.state === "cancelling") controller.abort();
  const promise = executeJob(id, controller.signal, adopt)
    .catch((e) => {
      s.lastError = `job ${id}: ${(e as Error).message}`.slice(0, 200);
    })
    .finally(() => {
      s.inflight.delete(id);
      kickRunner();
    });
  s.inflight.set(id, { controller, promise });
}

/** Wait for every in-flight job (tests). */
export async function drainRunner() {
  while (state().inflight.size) await Promise.all([...state().inflight.values()].map((f) => f.promise));
}

function setTriage(inboxId: string, kind: string, triageState: string, reason?: string) {
  if (kind !== "triage") return;
  getDb()
    .update(schema.workInbox)
    .set({ triageState, triageSkipReason: reason ?? null, updatedAt: new Date().toISOString() })
    .where(eq(schema.workInbox.id, inboxId))
    .run();
}

async function executeJob(id: string, signal: AbortSignal, adopt: boolean) {
  let row = getJobRow(id)!;
  const settings = getAiSettings();
  const kind = row.kind as AiJobKind;
  const user = userById(row.userId);
  if (!user) return void failJob(row, "upstream", "person not found");
  const params = JSON.parse(row.params || "{}") as {
    instructions?: string;
    contextSources?: ContextSource[];
    draftKind?: string;
    durationHint?: number;
    brief?: string;
    financeOverride?: boolean;
    deep?: boolean;
    investigateMode?: string;
  };
  // Guard again at execution: the item may have moved into an excluded area.
  const g = guardSubject(row.userId, kind, row.subjectType, row.subjectId, !!params.financeOverride);
  // Refused before anything starts: skip. A run that already exists upstream (adopted after a restart)
  // is stopped and reconciled instead, so it can't keep running after its lease and budget are released.
  const stopGuard = new AbortController();
  const refuse = (reason?: string) => {
    if (row.hermesRunId) {
      if (row.state === "running" || row.state === "waiting_approval")
        transition(id, row.state as JobState, "cancelling", { errorCode: "finance_excluded", errorMessage: errorText("finance_excluded") });
      stopGuard.abort();
      return false;
    }
    transition(id, row.state as JobState, "skipped", { errorCode: "finance_excluded", errorMessage: errorText("finance_excluded") });
    if (row.subjectType === "inbox") setTriage(row.subjectId, kind, "skipped", reason);
    return true;
  };
  if (!g.guard.ok && refuse(g.guard.reason)) return;
  // Build the run input (allowlisted context only).
  let input: string;
  let outbound = "";
  let title = g.subj.title;
  let areaTitle: string | null = g.area?.title ?? null;
  if (row.subjectType === "work_item") {
    const ctx = await itemContext(user, row.subjectId, params);
    title = ctx.detail.item.title;
    areaTitle = ctx.detail.area?.title ?? areaTitle;
    // Schedule estimation never gets calendar data or extra sources.
    const vars = {
      title,
      goal: ctx.detail.item.nextAction || ctx.detail.packets.at(-1)?.objective || ctx.detail.item.summary,
      areaTitle,
      defaultRepo: ctx.detail.area?.settings.defaultRepo,
      draftKind: params.draftKind,
      durationHint: params.durationHint,
    };
    outbound = kind === "schedule" ? (await itemContext(user, row.subjectId, { instructions: params.instructions })).text : ctx.text;
    input = `${taskFor(kind, vars)}\n\n${outbound}`;
  } else {
    const ctx = inboxContext(row.userId, row.subjectId, { imagesAnalysed: false, brief: params.brief });
    if (!ctx) return void failJob(row, "upstream", "capture not found");
    const dests =
      kind === "triage"
        ? triageDestinations(
            row.userId,
            (r) => effectiveAreaPolicy({ title: r.title, systemKey: r.systemKey, aiPolicy: parseAreaSettings(r.settings).aiPolicy }) === "excluded",
          )
        : [];
    input = `${taskFor(kind, { title, brief: params.brief, areaTitle, destinations: dests.map((d) => `${d.key} — ${d.path}`).join("\n") })}\n\n${ctx.text}`;
    outbound = ctx.text;
  }
  // Screen everything that leaves (packets, links, notes), not only the subject's own fields.
  if (g.guard.ok && !stopGuard.signal.aborted) {
    const full = financeGuard({ kind, area: g.area, text: outbound, financeOverride: !!params.financeOverride });
    if (!full.ok && refuse(full.reason)) return;
  }

  const cap = settings.jobCapsUsd[row.tier as "triage" | "standard" | "deep"] ?? settings.jobCapsUsd.standard;
  let lastCostCheck = 0;
  const conn = hermesConn();
  try {
    const result = await runHermesTask({
      label: AI_KIND_LABEL[kind],
      visible: row.visibleSession,
      title: row.visibleSession ? `✦ ${AI_KIND_LABEL[kind]} · ${title}` : `jarvis-ai:${kind}`,
      model: settings.hermes.perRunModel ? row.model : null,
      conn,
      instructions: instructionsFor(kind),
      input,
      schema: OUTPUT_SCHEMAS[kind] as never,
      idempotencyKey: row.idempotencyKey,
      timeoutMs: settings.timeoutsS[kind] * 1000,
      signal: AbortSignal.any([signal, stopGuard.signal]),
      adopt: adopt && row.hermesSessionId ? { sessionId: row.hermesSessionId, runId: row.hermesRunId } : undefined,
      onIds: (ids) => {
        setIds(id, ids);
        if (row.visibleSession) registerVisibleRun(row, ids, AI_KIND_LABEL[kind]);
      },
      onPoll: async ({ status, sessionId }) => {
        const cur = getJobRow(id);
        if (cur?.state === "waiting_approval" && status === "running") {
          transition(id, "waiting_approval", "running");
          if (cur.hermesRunId) setVisibleRunStatus(cur.hermesRunId, "running");
        }
        // Live per-job cap only when Hermes is verified to update session cost mid-run.
        if (settings.hermes.midRunCost && row.tier !== "triage" && Date.now() - lastCostCheck > 15_000) {
          lastCostCheck = Date.now();
          const c = await readCost(conn, sessionId);
          if (overCap(c.costUsd, cap)) return "stop";
        }
        return "continue";
      },
      onApproval: ({ sessionId, runId, command }) => {
        transition(id, "running", "waiting_approval");
        // The conversation's approval controls read the run store (activeRun / respondApproval).
        if (row.visibleSession) setVisibleRunStatus(runId, "waiting_for_approval");
        notify(
          {
            type: "ai.approval",
            category: "hermes_input",
            severity: "high",
            title: "Hermes needs approval",
            body: command ? `Hermes asked to run ${command}: approve in the conversation or cancel.` : "Approve in the conversation or cancel the job.",
            source: "hermes",
            deepLink: `/chat/${encodeURIComponent(sessionId)}`,
            dedupeKey: `ai:approval:${id}`,
          },
          row.userId,
        );
        kickDispatcher();
      },
    });
    row = getJobRow(id)!;
    const cost = result.cost.costUsd;
    const costPatch = {
      costUsd: cost ?? row.estimateUsd,
      costSource: result.cost.source ?? "jarvis_estimate",
      inputTokens: result.cost.inputTokens,
      outputTokens: result.cost.outputTokens,
    };
    await onSuccess(row, kind, result.data as Record<string, unknown>, costPatch, title, settings, params);
    settleVisibleRun(id);
  } catch (e) {
    try {
      await handleFailure(id, e, kind, title);
    } finally {
      settleVisibleRun(id);
    }
  }
}

async function handleFailure(id: string, e: unknown, kind: AiJobKind, title: string) {
  const row = getJobRow(id)!;
  const err = e instanceof HermesTaskError ? e : new HermesTaskError("upstream", "failed", { terminalObserved: false });
  const lc = takeLastCost(row.idempotencyKey);
  const costPatch = lc?.costUsd != null ? { costUsd: lc.costUsd, costSource: lc.source } : {};
  if (err.code === "cancelled") {
    if (err.ids.terminalObserved || !err.ids.runId) {
      const from = row.state as JobState;
      if (from === "cancelling" || from === "running" || from === "waiting_approval")
        transition(id, from === "cancelling" ? "cancelling" : from, from === "cancelling" ? "cancelled" : "cancelling", {
          errorCode: "cancelled",
          errorMessage: errorText("cancelled"),
        });
      const again = getJobRow(id)!;
      // A timeout/cost-cap stop that Hermes confirmed late keeps its original reason.
      const why = again.errorCode === "timeout" || again.errorCode === "cost_cap" ? (again.errorCode as JobErrorCode) : "cancelled";
      if (again.state === "cancelling") transition(id, "cancelling", "cancelled", { errorCode: why, errorMessage: errorText(why), ...costPatch });
    }
    // else: stays `cancelling`; the lease expires and the run is adopted until Hermes reports a terminal status.
    return;
  }
  const code = err.code as JobErrorCode;
  if (err.ids.runId && !err.ids.terminalObserved) {
    // Hermes didn't confirm the stop (e.g. timeout or cost cap): the upstream run may still be going.
    // Keep the job active (`cancelling`) so its lease expires and the runner adopts it by run id until
    // Hermes reports a terminal status; concurrency and the budget reservation stay held meanwhile.
    if (row.state === "running" || row.state === "waiting_approval")
      transition(id, row.state as JobState, "cancelling", { errorCode: code, errorMessage: errorText(code), ...costPatch });
    return;
  }
  if (!err.ids.runId && retryable(code, row.attempt, row.maxAttempts) && (row.state === "running" || row.state === "waiting_approval")) {
    transition(id, row.state as JobState, "queued", { notBefore: new Date(Date.now() + backoffMs(row.attempt)).toISOString(), errorCode: code });
    return;
  }
  if (["running", "waiting_approval", "cancelling"].includes(row.state)) failJob(row, code, undefined, costPatch);
  if (row.subjectType === "inbox") setTriage(row.subjectId, kind, "failed");
  if (kind !== "triage")
    notify(
      {
        type: "ai.job_failed",
        category: "info",
        severity: "info",
        title: `${AI_KIND_LABEL[kind]} failed: ${title}`.slice(0, 140),
        body: errorText(code),
        source: "work",
        deepLink:
          row.subjectType === "work_item" ? `/areas?item=${encodeURIComponent(row.subjectId)}` : `/areas?view=inbox&entry=${encodeURIComponent(row.subjectId)}`,
        dedupeKey: `ai:failed:${id}`,
      },
      row.userId,
    );
}

const RUN_STATUS_FOR: Record<string, string> = { succeeded: "completed", failed: "failed", cancelled: "cancelled", skipped: "cancelled" };

/**
 * Visible AI runs join the conversation machinery as soon as Hermes hands out ids:
 * the session belongs to the person who asked (not the household owner), and the
 * run gets a run-store row so the conversation shows it and its approval controls.
 * notifiedCompletion=true: the AI runner sends its own report/failure notices.
 */
function registerVisibleRun(row: typeof J.$inferSelect, ids: { sessionId?: string; runId?: string }, label: string) {
  const db = getDb();
  if (ids.sessionId) db.insert(schema.sessionMeta).values({ sessionId: ids.sessionId, userId: row.userId }).onConflictDoNothing().run();
  if (ids.sessionId && ids.runId)
    db.insert(schema.runs)
      .values({
        runId: ids.runId,
        sessionId: ids.sessionId,
        userId: row.userId,
        idempotencyKey: `ai:${row.idempotencyKey}`.slice(0, 255),
        status: "running",
        inputPreview: `✦ ${label}`.slice(0, 140),
        notifiedCompletion: true,
      })
      .onConflictDoNothing()
      .run();
}

function setVisibleRunStatus(runId: string, status: string) {
  const R = schema.runs;
  getDb()
    .update(R)
    .set({ status, lastCheckedAt: new Date().toISOString() })
    .where(and(eq(R.runId, runId), notInArray(R.status, ["completed", "failed", "cancelled", "interrupted"])))
    .run();
}

/** Once the job is terminal, its run-store row is too (an unconfirmed stop stays open until adopted and settled). */
function settleVisibleRun(id: string) {
  const row = getJobRow(id);
  if (!row?.visibleSession || !row.hermesRunId) return;
  const status = RUN_STATUS_FOR[row.state];
  if (!status) return;
  const R = schema.runs;
  getDb()
    .update(R)
    .set({ status, pendingApproval: null, completedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() })
    .where(and(eq(R.runId, row.hermesRunId), notInArray(R.status, ["completed", "failed", "cancelled", "interrupted"])))
    .run();
}

async function onSuccess(
  row: typeof J.$inferSelect,
  kind: AiJobKind,
  data: Record<string, unknown>,
  costPatch: Record<string, unknown>,
  title: string,
  settings: ReturnType<typeof getAiSettings>,
  params: { investigateMode?: string },
) {
  if (kind === "triage") {
    const t = data as {
      title: string;
      kind: string;
      destinationKey: string | null;
      confidence: number;
      reason: string;
      shouldInvestigate: boolean;
      brief: string;
      sensitivity: string;
    };
    const dest = t.destinationKey
      ? getDb()
          .select({ id: schema.workItems.id })
          .from(schema.workItems)
          .where(and(eq(schema.workItems.id, t.destinationKey), eq(schema.workItems.userId, row.userId)))
          .get()
      : undefined;
    getDb()
      .update(schema.workInbox)
      .set({
        triageState: "done",
        suggestedTitle: t.title,
        suggestedKind: t.kind,
        suggestedParentId: dest?.id ?? null,
        suggestionConfidence: t.confidence,
        suggestionReason: t.reason.slice(0, 300),
        sensitivity: t.sensitivity === "none" ? "none" : t.sensitivity,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workInbox.id, row.subjectId))
      .run();
    transition(row.id, row.state as JobState, "succeeded", costPatch);
    const destArea = dest ? (await import("./jobs")).areaOf(row.userId, dest.id) : null;
    const mode = (params.investigateMode as "auto" | "triage_only" | "off" | undefined) ?? "auto";
    if (
      shouldInvestigate(
        { shouldInvestigate: t.shouldInvestigate, confidence: t.confidence, sensitivity: t.sensitivity as never },
        settings,
        mode,
        effectiveAreaPolicy(destArea),
      )
    ) {
      try {
        enqueue({
          userId: row.userId,
          kind: "investigate",
          subjectType: "inbox",
          subjectId: row.subjectId,
          clientKey: `auto${row.id.replace(/[^A-Za-z0-9]/g, "").slice(-20)}`,
          params: { brief: t.brief },
          correlationId: row.id,
        });
        kickRunner();
      } catch {
        /* guard refused (e.g. finance detected): the suggestion stays */
      }
    }
    return;
  }
  let draft;
  if (kind === "schedule") {
    const est = data as {
      durationMinutes: number;
      splitOk: boolean;
      preferredWindows: string[];
      earliest?: string | null;
      deadline?: string | null;
      reason: string;
    };
    const slots = await scheduleSlotsFor(row.userId, est);
    draft = {
      title: `Suggested times · ${title}`.slice(0, 120),
      summary: slots.length
        ? `About ${est.durationMinutes} min. ${slots.length} free slot${slots.length === 1 ? "" : "s"} in your calendars.`
        : `About ${est.durationMinutes} min. No free slot in the next 14 days within your hours.`,
      bodyMd: est.reason,
      structured: { ...est, slots },
      confidence: "medium" as const,
      sources: [],
    };
  } else draft = draftFromOutput(kind, data);
  const reportId = writeReport(getJobRow(row.id)!, draft, { costUsd: (costPatch.costUsd as number | null) ?? null });
  if (row.subjectType === "work_item" && row.visibleSession) linkConversation(getJobRow(row.id)!, row.subjectId, `✦ ${AI_KIND_LABEL[kind]} · ${title}`);
  transition(row.id, row.state as JobState, "succeeded", { ...costPatch, reportId });
  notifyReport(row, reportId, title, draft.summary);
}

function notifyReport(row: typeof J.$inferSelect, reportId: string, title: string, summary: string) {
  const now = new Date();
  const bucket = reportBucket(now);
  const since = new Date(bucket * 10 * 60_000).toISOString();
  const recent = getDb()
    .select({ id: schema.notifications.id, createdAt: schema.notifications.createdAt })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, row.userId), eq(schema.notifications.type, "ai.report_ready")))
    .all()
    .filter((n) => n.createdAt >= since).length;
  const deepLink =
    row.subjectType === "work_item"
      ? `/areas?item=${encodeURIComponent(row.subjectId)}&report=${encodeURIComponent(reportId)}`
      : `/areas?view=inbox&entry=${encodeURIComponent(row.subjectId)}`;
  if (recent >= 3) {
    // Batch: >3 in 10 minutes collapse into one escalating row.
    notify(
      {
        type: "ai.reports_ready",
        category: "ai_report",
        severity: "normal",
        title: `${recent + 1} reports ready`,
        body: "Open Today to see what Jarvis prepared.",
        source: "work",
        deepLink: "/areas?view=today",
        dedupeKey: `ai:reports:${bucket}`,
      },
      row.userId,
    );
  } else
    notify(
      {
        type: "ai.report_ready",
        category: "ai_report",
        severity: "normal",
        title: `Report ready · ${title}`.slice(0, 140),
        body: summary.slice(0, 140) || `${KIND_VERB[row.kind as AiJobKind]} finished.`,
        source: "work",
        deepLink,
        dedupeKey: `ai:report:${row.id}`,
      },
      row.userId,
    );
  kickDispatcher();
}

// --- Scheduling ---

function schedule(ms: number) {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => void wake(), ms);
  s.timer.unref?.();
}

async function wake() {
  const s = state();
  if (!runnerConfigured()) {
    // Disabled: claim nothing new, but keep jobs already in flight cancellable and leased until they end.
    try {
      maintainInflight();
    } catch {
      /* never throws */
    }
    if (s.inflight.size) schedule(3_000);
    else stopAiRunner();
    return;
  }
  if (!s.ticking) {
    s.ticking = true;
    try {
      await runnerTick();
    } finally {
      s.ticking = false;
    }
  }
  if (s.armed) schedule(activeCount() > 0 || s.inflight.size ? 3_000 : 60_000);
}

/** Arm the runner when AI is enabled and Hermes is configured. Idempotent; independent of the general worker. */
export function startAiRunner() {
  const s = state();
  if (!runnerConfigured()) return false;
  if (s.armed) return true;
  s.armed = true;
  schedule(5_000);
  return true;
}

export function stopAiRunner() {
  const s = state();
  s.armed = false;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  // Jobs already running keep their leases and stay cancellable until they end (see wake()).
  if (s.inflight.size) schedule(3_000);
}

/** Tick soon (after an enqueue or a finished job). */
export function kickRunner() {
  const s = state();
  if (!s.armed) {
    if (!startAiRunner() && s.inflight.size) schedule(250); // disabled with jobs in flight (e.g. a cancel)
    return;
  }
  schedule(250);
}

export function aiRunnerStatus() {
  const s = state();
  const counts = getDb()
    .select({ state: J.state })
    .from(J)
    .where(inArray(J.state, ["queued", "running", "waiting_approval", "cancelling", "budget_blocked"]))
    .all();
  return {
    armed: s.armed,
    running: counts.filter((c) => c.state === "running" || c.state === "waiting_approval" || c.state === "cancelling").length,
    queued: counts.filter((c) => c.state === "queued").length,
    budgetBlocked: counts.filter((c) => c.state === "budget_blocked").length,
    lastTickAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null,
    lastError: s.lastError,
  };
}
