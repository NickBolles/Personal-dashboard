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
  startWorker();
}
