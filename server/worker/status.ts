/** Worker liveness, split out so the AI runner/dispatcher can check it without importing the worker (and its source registry). */
type WorkerState = { timer: NodeJS.Timeout; running: boolean; lastRun?: string; lastError?: string };
export const workerGlobal = globalThis as unknown as { __jarvisWorker?: WorkerState };

export function workerStatus() {
  const w = workerGlobal.__jarvisWorker;
  return w ? { running: true, lastRun: w.lastRun, lastError: w.lastError } : { running: false };
}
