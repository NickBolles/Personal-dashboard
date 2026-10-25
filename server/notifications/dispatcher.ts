import "server-only";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { processSingleton } from "@/server/singleton";
import { workerStatus } from "@/server/worker/status";
import { deliverPendingPushes } from "./push";

/**
 * Standalone push dispatcher (spec §3.5, owner decision D17): delivers the
 * notification outbox every `dispatchSeconds` (default 30 s) even when the
 * general worker is disabled in production (JARVIS_DISABLE_WORKER=true). When
 * the worker runs, it skips (the worker tick already delivers). Rows are
 * claimed with a conditional update in deliverPendingPushes, so concurrent
 * callers never send the same push twice.
 */
type DispatcherState = {
  timer: NodeJS.Timeout | null;
  kick: NodeJS.Timeout | null;
  running: boolean;
  lastRunAt: number | null;
  lastSent: number;
  lastError: string | null;
};
const state = () =>
  processSingleton<DispatcherState>("notification_dispatcher", () => ({
    timer: null,
    kick: null,
    running: false,
    lastRunAt: null,
    lastSent: 0,
    lastError: null,
  }));

export function hasPendingPushes(now = new Date()) {
  const N = schema.notifications;
  return !!getDb()
    .select({ id: N.id })
    .from(N)
    .where(and(eq(N.pushState, "pending"), or(isNull(N.scheduledFor), lte(N.scheduledFor, now.toISOString()))))
    .limit(1)
    .get();
}

/** One dispatch pass (exported for tests). Never throws. */
export async function dispatchOnce(now = new Date()) {
  const s = state();
  if (s.running) return { skipped: "busy" as const };
  if (workerStatus().running) return { skipped: "worker" as const };
  s.running = true;
  try {
    if (!hasPendingPushes(now)) return { sent: 0 };
    const sent = await deliverPendingPushes(now);
    s.lastSent = sent;
    s.lastError = null;
    return { sent };
  } catch (e) {
    s.lastError = (e as Error).message.slice(0, 200);
    return { error: s.lastError };
  } finally {
    s.running = false;
    s.lastRunAt = now.getTime();
  }
}

export function startNotificationDispatcher(intervalSeconds = 30) {
  const s = state();
  if (s.timer) return false;
  s.timer = setInterval(() => void dispatchOnce(), Math.max(5, intervalSeconds) * 1000);
  s.timer.unref?.();
  return true;
}

export function stopNotificationDispatcher() {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/** Deliver within about a second (after notify() from the AI runner). */
export function kickDispatcher() {
  const s = state();
  if (s.kick) return;
  s.kick = setTimeout(() => {
    s.kick = null;
    void dispatchOnce();
  }, 1000);
  s.kick.unref?.();
}

export function dispatcherStatus() {
  const s = state();
  return { running: !!s.timer, lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null, lastSent: s.lastSent, lastError: s.lastError };
}
