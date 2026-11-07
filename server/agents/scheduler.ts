import "server-only";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { getOwner, userById, type CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { newId } from "@/server/crypto";
import { getPreferences } from "@/server/settings";
import { processSingleton } from "@/server/singleton";
import { createSession, startRun, getRun, getSessionDetail } from "@/server/assistant";
import { sessionProfile } from "@/integrations/hermes/service";
import { resolveAgentForNode } from "./routing";
import { coordinatorFor } from "@/server/work/coordinator";
import { conversationNodes, listItems, placeConversation } from "@/server/work/store";
import { registerAgentRun, finishRegisteredRun } from "@/server/work/registered-runs";
import { agentRuns } from "@/server/work/agent-runs";
import { isStalled } from "@/lib/agent-runs";
import { agentItems } from "@/server/agent-access/tools";
import { detectSensitivity } from "@/server/ai/rules";
import { notify } from "@/server/notifications";
import {
  dueSlot,
  slotKey,
  manualSlotKey,
  effectiveAutonomy,
  policyInstructions,
  inQuietHours,
  quietEnd,
  parseProposals,
  isSilentReport,
  MAX_CONSECUTIVE_FAILURES,
  RUN_TIMEOUT_MS,
  WAITING_SUMMARY,
  type ScheduledJob,
  type AwayRun,
} from "@/lib/away";
import { J, R, assertAwayOwner, jobRows, jobRow, jobView, runCaps, type JobRow, type RunRow } from "./schedules";
import { applyProposals } from "./proposals";
import { awayRun } from "./away";

export const defaultDeps = { createSession, startRun, getRun, getSessionDetail, resolveAgentForNode, sessionProfile, coordinatorFor, notify };
export type SchedulerDeps = typeof defaultDeps;
const state = () => processSingleton("away_scheduler", () => ({ running: false, reconciling: new Set<string>(), lastReconcile: new Map<string, number>() }));
const ownerIdentity = () => {
  const row = getOwner();
  return row ? userById(row.id) : null;
};
function areaFor(user: CurrentUser, job: JobRow) {
  return listItems(user.id).find((i) => i.id === job.areaId && i.kind === "area" && i.parentId === null && !i.archived);
}
function runningJob(id: string) {
  return getDb()
    .select()
    .from(R)
    .where(and(eq(R.jobId, id), eq(R.status, "running")))
    .get();
}

/** Atomic reservation. A running reservation counts against the cap before any network await. */
export function claimJobSlot(user: CurrentUser, job: JobRow, slot: string, now: Date, skip?: ScheduledJob["lastStatus"]): RunRow | null {
  const db = getDb();
  const id = newId("away");
  const res = db
    .insert(R)
    .values({
      id,
      userId: user.id,
      jobId: job.id,
      slot,
      status: skip ? "skipped" : "running",
      startedAt: now.toISOString(),
      finishedAt: skip ? now.toISOString() : null,
      error: skip ?? null,
    })
    .onConflictDoNothing({ target: [R.jobId, R.slot] })
    .run();
  if (!res.changes) return null;
  db.update(J)
    .set({ lastStatus: skip ?? "running", lastError: skip ?? null, lastRunAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(J.id, job.id))
    .run();
  return db.select().from(R).where(eq(R.id, id)).get()!;
}
function notification(user: CurrentUser, job: JobRow, row: RunRow, now: Date, deps: SchedulerDeps, body: string, dedupe = `away:${row.id}`) {
  deps.notify(
    {
      type: "scheduled_job",
      category: "hermes_input",
      severity: "normal",
      title: job.title,
      body,
      source: "jarvis",
      deepLink: "/home",
      dedupeKey: dedupe,
      scheduledFor: quietEnd(now, getPreferences(user.id).quietHours, job.tz).toISOString(),
    },
    user.id,
  );
}
function fail(user: CurrentUser, row: RunRow, now: Date, error: string, deps: SchedulerDeps) {
  getDb().transaction(() => {
    const live = getDb().select().from(R).where(eq(R.id, row.id)).get();
    if (live?.status !== "running") return;
    const job = jobRow(user, row.jobId, true);
    const failures = job.consecutiveFailures + 1;
    const disabled = failures >= MAX_CONSECUTIVE_FAILURES;
    const message = disabled ? "Switched off after 5 failures in a row" : error.slice(0, 600);
    getDb()
      .update(R)
      .set({ status: "failed", finishedAt: now.toISOString(), error: error.slice(0, 600) })
      .where(eq(R.id, row.id))
      .run();
    getDb()
      .update(J)
      .set({ lastStatus: "failed", lastError: message, consecutiveFailures: failures, ...(disabled ? { enabled: false } : {}), updatedAt: now.toISOString() })
      .where(eq(J.id, job.id))
      .run();
    if (row.agentRunId) finishRegisteredRun(user, row.agentRunId, "failed", message, now);
    notification(user, job, row, now, deps, message);
  });
}

/** Run-now ignores quiet hours, but never area policy, cap or concurrent-run protection. */
export async function startJobRun(user: CurrentUser, job: JobRow, slot: string, deps: SchedulerDeps = defaultDeps, now = new Date()): Promise<AwayRun> {
  assertAwayOwner(user);
  const row = getDb().transaction(() => {
    // Always re-read: an owner may have changed policy/job while another tick awaited Hermes.
    job = jobRow(user, job.id);
    const area = areaFor(user, job);
    if (!area) throw new HttpError(409, "not_ready", "Pick an area and coordinator first");
    if (effectiveAutonomy(area) === "off") throw new HttpError(409, "ai_off", "AI is off in this area");
    if (detectSensitivity([job.prompt, area.settings?.instructions].filter(Boolean).join("\n")) === "credentials")
      throw new HttpError(409, "ai_off", "Scheduled prompts cannot include credentials");
    if (!area.settings?.agentMode) throw new HttpError(409, "not_ready", "Set an area coordinator first");
    const resolution = deps.resolveAgentForNode(user.id, area.id);
    if (!["default", "routing_off", "routed"].includes(resolution.reason)) throw new HttpError(409, "not_ready", "The coordinator route isn't ready");
    if (runningJob(job.id)) throw new HttpError(409, "already_running", "This job is already running");
    const caps = runCaps(user, now);
    if (caps.runsToday >= caps.maxRunsPerDay) throw new HttpError(409, "daily_cap", "The daily run cap is reached");
    const claimed = claimJobSlot(user, job, slot, now);
    if (!claimed) throw new HttpError(409, "already_running", "This slot has already run");
    return claimed;
  });
  try {
    let area = areaFor(user, job)!;
    const resolution = deps.resolveAgentForNode(user.id, area.id);
    let profile = resolution.profile;
    let sessionId = job.sessionId;
    const node = sessionId ? conversationNodes(user.id).get(sessionId) : null;
    if (!node || node.archived || node.parentId !== area.id || deps.sessionProfile(sessionId!) !== profile) {
      const session = await deps.createSession(user, `Scheduled · ${job.title}`, "hermes", profile);
      sessionId = session.id;
      placeConversation(user, { sessionId, parentId: area.id, title: `Scheduled · ${job.title}` }, "scheduled-session");
      getDb().update(J).set({ sessionId }).where(eq(J.id, job.id)).run();
    } else profile = deps.sessionProfile(sessionId!);
    // Recheck after session creation, before context construction or sending anything.
    area = areaFor(user, job)!;
    if (!area || effectiveAutonomy(area) === "off") throw new HttpError(409, "ai_off", "AI is off in this area");
    const context = deps.coordinatorFor(user, area.id).prompt;
    const visible = agentItems(user.id).items;
    const stalled =
      job.kind === "stalled"
        ? Object.values(agentRuns(user, visible).items)
            .filter((r) => r.live === "failed" || r.agentRuns?.some((r) => isStalled(r, now.getTime())))
            .map((r) => `${r.title}: ${r.live}`)
            .filter((t) => detectSensitivity(t) !== "credentials")
            .slice(0, 12)
            .join("\n")
        : "";
    const prefs = getPreferences().hermes;
    const settings = area.settings;
    const modeHint = settings?.agentMode && settings.agentMode !== profile ? `Agent mode: ${settings.agentMode}.` : "";
    const instructions = maskAccountNumbers([modeHint, settings?.instructions, policyInstructions(effectiveAutonomy(area))].filter(Boolean).join("\n\n"));
    const rawInput = [job.prompt, context, stalled].filter(Boolean).join("\n\n");
    if (detectSensitivity(rawInput) === "credentials") throw new HttpError(409, "ai_off", "Scheduled context contains credentials");
    const input = maskAccountNumbers(rawInput);
    const registered = registerAgentRun(
      user,
      profile ?? "default",
      { itemId: area.id, title: `Scheduled: ${job.title}`, hermesSessionId: sessionId!, delegationId: `sched:${row.id}` },
      "scheduled-run",
      null,
      now,
    );
    row.agentRunId = registered.runId;
    row.sessionId = sessionId;
    row.profile = profile ?? "default";
    getDb().update(R).set({ sessionId, agentRunId: row.agentRunId, profile: row.profile }).where(eq(R.id, row.id)).run();
    const run = await deps.startRun(
      user,
      {
        sessionId: sessionId!,
        input,
        instructions,
        idempotencyKey: `sched:${job.id}:${slot}`,
        model: settings?.defaultModel || prefs.defaultModel || undefined,
        provider: settings?.defaultProvider || prefs.defaultProvider || undefined,
        ...(prefs.defaultReasoning && !settings?.defaultModel ? { modelOptions: { reasoning: { effort: prefs.defaultReasoning } } } : {}),
      },
      "scheduled-run",
    );
    getDb().update(R).set({ hermesRunId: run.runId }).where(eq(R.id, row.id)).run();
  } catch (e) {
    fail(user, row, now, e instanceof Error ? e.message : "Couldn't start", deps);
  }
  return awayRun(user, getDb().select().from(R).where(eq(R.id, row.id)).get()!);
}
export const runJobNow = (user: CurrentUser, id: string, now = new Date(), deps = defaultDeps) =>
  startJobRun(user, jobRow(user, id), manualSlotKey(now), deps, now);

export async function reconcileScheduledRuns(user: CurrentUser, now = new Date(), deps: SchedulerDeps = defaultDeps, throttled = false) {
  assertAwayOwner(user);
  const s = state();
  if (s.reconciling.has(user.id) || (throttled && now.getTime() - (s.lastReconcile.get(user.id) ?? 0) < 10_000)) return;
  s.reconciling.add(user.id);
  s.lastReconcile.set(user.id, now.getTime());
  try {
    for (const row of getDb()
      .select()
      .from(R)
      .where(and(eq(R.userId, user.id), eq(R.status, "running")))
      .all()) {
      if (now.getTime() - Date.parse(row.startedAt) > RUN_TIMEOUT_MS) {
        fail(user, row, now, row.summary === WAITING_SUMMARY ? "Timed out waiting for your approval" : "Timed out", deps);
        continue;
      }
      if (!row.hermesRunId) continue;
      try {
        const run = await deps.getRun(user, row.hermesRunId);
        if (run.pendingApproval || run.pendingClarify || run.status === "waiting_for_approval") {
          // Blocked on a prompt: show it as Needs you (digest + agent panel) and tell the owner once,
          // instead of looking "running" until the 2 h timeout (#230).
          if (row.summary !== WAITING_SUMMARY) {
            getDb().update(R).set({ summary: WAITING_SUMMARY }).where(eq(R.id, row.id)).run();
            notification(user, jobRow(user, row.jobId, true), row, now, deps, "Waiting for your approval in its conversation", `away-wait:${row.id}`);
          }
          if (row.agentRunId) finishRegisteredRun(user, row.agentRunId, "waiting", WAITING_SUMMARY, now);
          continue;
        }
        if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
          if (row.summary === WAITING_SUMMARY) getDb().update(R).set({ summary: null }).where(eq(R.id, row.id)).run();
          if (row.agentRunId) finishRegisteredRun(user, row.agentRunId, "running", "Running", now);
          continue;
        }
        if (run.status !== "completed") {
          fail(user, row, now, run.error || "Run failed", deps);
          continue;
        }
        const job = jobRow(user, row.jobId, true);
        const area = areaFor(user, job);
        // A formerly eligible area may now be excluded. Never retrieve its transcript or apply output.
        if (!area || effectiveAutonomy(area) === "off") {
          fail(user, row, now, "Area no longer allows AI", deps);
          continue;
        }
        let output = run.output;
        if (!output && row.sessionId) {
          const detail = await deps.getSessionDetail(user, row.sessionId);
          const last = detail.timeline.filter((m) => m.kind === "assistant").at(-1);
          output = last?.kind === "assistant" ? last.text : "";
        }
        const parsed = parseProposals(output);
        const silent = isSilentReport(parsed.report, parsed.proposals);
        const summary = parsed.report
          .replace(/<[^>]*>|[`*_#]/g, "")
          .replace(/\s+/g, " ")
          .slice(0, 600);
        getDb().transaction(() => {
          // Local writes and the terminal marker commit together. Cross-process readers cannot apply twice.
          if (getDb().select().from(R).where(eq(R.id, row.id)).get()?.status !== "running") return;
          const applied = applyProposals(user, area.id, job.title, row.profile ?? "default", parsed.proposals);
          if (parsed.dropped) applied.refused.push({ intent: "invalid", label: `${parsed.dropped} invalid or excess proposals dropped` });
          getDb()
            .update(R)
            .set({
              status: "done",
              silent,
              summary,
              report: parsed.report.slice(0, 8000),
              finishedAt: now.toISOString(),
              changesJson: JSON.stringify(applied.changes),
              decisionsJson: JSON.stringify(applied.decisions),
              refusedJson: JSON.stringify(applied.refused),
            })
            .where(eq(R.id, row.id))
            .run();
          getDb()
            .update(J)
            .set({ lastStatus: silent ? "silent" : "ok", lastError: null, consecutiveFailures: 0, updatedAt: now.toISOString() })
            .where(eq(J.id, job.id))
            .run();
          if (row.agentRunId) finishRegisteredRun(user, row.agentRunId, "done", summary, now);
          if (!silent && applied.decisions.length) notification(user, job, row, now, deps, `${applied.decisions.length} proposals need you`);
        });
      } catch (e) {
        // Transient read failures retry on the next tick, bounded by the timeout above.
        console.error("[jarvis] scheduled reconciliation failed", e instanceof Error ? e.name : "Error");
      }
    }
  } finally {
    s.reconciling.delete(user.id);
  }
}

/** Awaitable worker pass for tests. Production dispatch uses the non-blocking wrapper below. */
export async function runSchedulePass(now: Date, deps: SchedulerDeps = defaultDeps) {
  const user = ownerIdentity();
  if (!user) return;
  await reconcileScheduledRuns(user, now, deps);
  let started = 0;
  for (const job of jobRows(user).filter((j) => j.enabled)) {
    const at = dueSlot(jobView(user, job, now).schedule, now, job.tz);
    if (!at || runningJob(job.id)) continue;
    const slot = slotKey(at);
    const area = areaFor(user, job);
    const caps = runCaps(user, now);
    const skip =
      !area ||
      effectiveAutonomy(area) === "off" ||
      !area.settings?.agentMode ||
      detectSensitivity([job.prompt, area.settings?.instructions].filter(Boolean).join("\n")) === "credentials"
        ? "skipped_policy"
        : !job.overnight && inQuietHours(at, getPreferences(user.id).quietHours, job.tz)
          ? "skipped_quiet"
          : caps.runsToday >= caps.maxRunsPerDay
            ? "skipped_cap"
            : null;
    if (skip) {
      claimJobSlot(user, job, slot, now, skip);
      continue;
    }
    if (started >= 2) continue;
    try {
      await startJobRun(user, job, slot, deps, now);
      started++;
    } catch (e) {
      if (!(e instanceof HttpError)) console.error("[jarvis] scheduled start failed");
    }
  }
}
export function tickSchedules(now = new Date(), deps: SchedulerDeps = defaultDeps) {
  const s = state();
  if (s.running) return;
  s.running = true;
  void runSchedulePass(now, deps)
    .catch(() => console.error("[jarvis] scheduled tick failed"))
    .finally(() => {
      s.running = false;
    });
}
