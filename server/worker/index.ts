import "server-only";
import { config } from "@/server/config";
import { getOwner, pruneSessions } from "@/server/auth";
import { getPreferences } from "@/server/settings";
import { notify, pruneNotifications } from "@/server/notifications";
import { deliverPendingPushes } from "@/server/notifications/push";
import { collectSources, failureInfo } from "@/server/sources";
import { SOURCE_LABELS, type ActionSource } from "@/lib/contracts";
import { MINUTE } from "@/lib/time";
import { markCompletionNotified, reconcileRun, runsNeedingCompletionNotice, unfinishedRuns } from "@/integrations/hermes/service";
import { isConfigured } from "@/integrations/store";
import { reminderInstant } from "@/integrations/daily-compass/adapter";

const g = globalThis as unknown as { __jarvisWorker?: { timer: NodeJS.Timeout; running: boolean; lastRun?: string; lastError?: string } };

/** One worker tick. Exported for tests and the /api/worker/tick admin route. */
export async function tick(now = new Date()) {
  if (!getOwner()) return { skipped: "unclaimed" };
  const prefs = getPreferences();
  const summary: Record<string, unknown> = {};

  // 1. Hermes runs: reconcile anything not yet terminal; alert on approvals and unseen completions.
  if (isConfigured("hermes")) {
    for (const run of unfinishedRuns()) {
      try {
        const view = await reconcileRun(run.runId);
        if (view.status === "waiting_for_approval" && view.pendingApproval) {
          notify({
            type: "hermes.approval",
            category: "hermes_input",
            severity: "high",
            title: "Hermes needs your approval",
            body: view.pendingApproval.description ?? view.pendingApproval.command ?? "A running task is waiting for you.",
            source: "hermes",
            deepLink: `/chat/${encodeURIComponent(run.sessionId)}`,
            dedupeKey: `approval:${run.runId}:${view.pendingApproval.requestId ?? "pending"}`,
          });
        }
      } catch (err) {
        summary.runError = (err as Error).message;
      }
    }
    for (const run of runsNeedingCompletionNotice()) {
      const failed = run.status !== "completed";
      notify({
        type: "hermes.run_finished",
        category: "hermes_complete",
        severity: failed ? "high" : "normal",
        title: failed ? `Hermes run ${run.status}` : "Hermes finished",
        body: run.inputPreview ? `“${run.inputPreview}”` : "Background work finished.",
        source: "hermes",
        deepLink: `/chat/${encodeURIComponent(run.sessionId)}`,
        dedupeKey: `run:${run.runId}`,
      });
      markCompletionNotified(run.runId);
    }
  }

  // 2. Sources: refresh, then derive alerts.
  const { ctx, results } = await collectSources({ live: true });
  summary.sources = results.map((r) => `${r.status.source}:${r.status.state}`);
  for (const r of results) {
    const src = r.status.source as ActionSource;
    if (src === "home_assistant") {
      for (const e of r.data?.homeExceptions ?? []) {
        if (e.severity !== "critical" && e.severity !== "high") continue;
        notify({
          type: "home.exception",
          category: "ha_critical",
          severity: e.severity,
          title: `${e.name}: ${e.reason}`,
          body: `Current state: ${e.state}`,
          source: "home_assistant",
          deepLink: `/home-control?entity=${encodeURIComponent(e.entityId)}`,
          dedupeKey: `ha:${e.entityId}:${e.since ?? ""}`,
        });
      }
    }
    if (src === "todos") {
      const overdue = (r.data?.actions ?? []).filter((a) => a.status === "open" && a.priorityReason === "overdue");
      if (overdue.length) {
        notify({
          type: "todos.overdue",
          category: "overdue",
          severity: "normal",
          title: overdue.length === 1 ? "1 overdue todo" : `${overdue.length} overdue todos`,
          body: overdue
            .slice(0, 3)
            .map((a) => a.title)
            .join(" · "),
          source: "todos",
          deepLink: "/todos",
          dedupeKey: `overdue:${ctx.today}`,
        });
      }
    }
    if (src === "daily_compass" && r.data?.compass && !r.data.compass.completed) {
      const at = reminderInstant(ctx);
      if (now >= at && now.getTime() - at.getTime() < 3 * 60 * MINUTE) {
        notify({
          type: "daily_compass.reminder",
          category: "daily_compass",
          severity: "normal",
          title: "Daily Compass",
          body: "Your check-in window is open. Two minutes to close out the day?",
          source: "daily_compass",
          deepLink: "/daily-compass",
          dedupeKey: `compass:${ctx.today}`,
        });
      }
    }
    const f = failureInfo(src);
    if (f?.firstFailureAt && (f.state === "error" || f.state === "unauthorized")) {
      const minutes = (now.getTime() - new Date(f.firstFailureAt).getTime()) / MINUTE;
      if (minutes >= prefs.integrationFailureAlertMinutes) {
        notify({
          type: "integration.failure",
          category: "integration_failure",
          severity: f.state === "unauthorized" ? "high" : "normal",
          title: `${SOURCE_LABELS[src]} ${f.state === "unauthorized" ? "needs re-authentication" : "is failing"}`,
          body: f.error ?? "Repeated errors",
          source: src,
          deepLink: "/settings/connections",
          dedupeKey: `integration:${src}:${f.firstFailureAt}`,
        });
      }
    }
  }

  // 3. Outbox
  summary.pushed = await deliverPendingPushes(now);

  // 4. Housekeeping
  pruneSessions();
  pruneNotifications();
  return summary;
}

export function startWorker() {
  if (!config.workerEnabled || g.__jarvisWorker) return;
  const state = { running: false } as { timer: NodeJS.Timeout; running: boolean; lastRun?: string; lastError?: string };
  const run = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await tick();
      state.lastRun = new Date().toISOString();
      state.lastError = undefined;
    } catch (err) {
      state.lastError = (err as Error).message;
      console.error("[jarvis] worker tick failed", err);
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(run, config.workerIntervalMs);
  state.timer.unref?.();
  g.__jarvisWorker = state;
  setTimeout(run, 5_000).unref?.();
  console.log(`[jarvis] background worker started (every ${config.workerIntervalMs / 1000}s)`);
}

export function workerStatus() {
  const w = g.__jarvisWorker;
  return w ? { running: true, lastRun: w.lastRun, lastError: w.lastError } : { running: false };
}
