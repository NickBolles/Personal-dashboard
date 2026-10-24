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
}
