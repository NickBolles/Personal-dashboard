export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { logSetupCodeIfUnclaimed } = await import("./server/auth");
  const { startWorker } = await import("./server/worker");
  try {
    logSetupCodeIfUnclaimed();
  } catch (err) {
    console.error("[jarvis] startup check failed", err);
  }
  // startWorker() is a no-op with JARVIS_DISABLE_WORKER=true (production).
  startWorker();
  // The Work GitHub poller is separate from the worker: it only arms itself when a GitHub
  // connection exists and work.github.poll_minutes > 0 (server/work/github-poller.ts).
  try {
    const { startWorkGithubPoller } = await import("./server/work/github-poller");
    startWorkGithubPoller();
  } catch (err) {
    console.error("[jarvis] work GitHub poller didn't start", (err as Error).message);
  }
  // Standalone push dispatcher (independent of JARVIS_DISABLE_WORKER; skips while the worker runs).
  try {
    const { startNotificationDispatcher } = await import("./server/notifications/dispatcher");
    const { getAiSettings } = await import("./server/ai/settings");
    startNotificationDispatcher(getAiSettings().dispatchSeconds);
  } catch (err) {
    console.error("[jarvis] push dispatcher didn't start", (err as Error).message);
  }
  // Keep the Areas conversation index warm (stale-while-revalidate; Hermes' list takes 4–9 s).
  try {
    const { registerDispatcherTask } = await import("./server/notifications/dispatcher");
    const { warmConversationIndexes } = await import("./server/work/conversations");
    registerDispatcherTask("conversation_index_warm", 60_000, (now) => warmConversationIndexes(now));
  } catch (err) {
    console.error("[jarvis] conversation warmer didn't start", (err as Error).message);
  }
  // Integration failure alerts: the worker derives them in tick(), but production runs with it
  // disabled, so failing syncs (e.g. Skylight) were never surfaced. Read-only check of recorded streaks.
  try {
    const { config } = await import("./server/config");
    if (!config.workerEnabled) {
      const { registerDispatcherTask } = await import("./server/notifications/dispatcher");
      const { alertIntegrationFailures } = await import("./server/worker");
      registerDispatcherTask("integration_failure_alerts", 5 * 60_000, (now) => alertIntegrationFailures(now));
    }
  } catch (err) {
    console.error("[jarvis] integration failure alerts didn't start", (err as Error).message);
  }
  // AI job runner: only arms itself while ai.enabled and Hermes is configured (server/ai/runner.ts).
  try {
    const { startAiRunner } = await import("./server/ai/runner");
    startAiRunner();
  } catch (err) {
    console.error("[jarvis] AI runner didn't start", (err as Error).message);
  }
}
