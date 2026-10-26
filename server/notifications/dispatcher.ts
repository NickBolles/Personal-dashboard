import "server-only";
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { processSingleton } from "@/server/singleton";
import { workerStatus } from "@/server/worker/status";
import { purgeDismissedCaptures } from "@/server/capture/purge";
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
  lastPurgeAt: number | null;
};
const state = () =>
  processSingleton<DispatcherState>("notification_dispatcher", () => ({
    timer: null,
    kick: null,
    running: false,
    lastRunAt: null,
    lastSent: 0,
    lastError: null,
    lastPurgeAt: null,
  }));

export function hasPendingPushes(now = new Date()) {
  const N = schema.notifications;
  return !!getDb()
    .select({ id: N.id })
    .from(N)
    .where(
      or(
        and(eq(N.pushState, "pending"), or(isNull(N.scheduledFor), lte(N.scheduledFor, now.toISOString()))),
        // A claim left in `sending` by a crash/restart is reclaimable after 5 minutes (claimPush).
        and(eq(N.pushState, "sending"), lt(N.pushAttemptedAt, new Date(now.getTime() - 5 * 60_000).toISOString())),
      ),
    )
    .limit(1)
    .get();
}

/**
 * Light periodic jobs that must run in production too (where the general
 * worker is disabled) ride this tick. Registered from instrumentation.ts so
 * this module (reachable from server/ai) imports nothing of theirs. Each runs
 * at most every `everyMs`, must not block (start background work and return),
 * and its failures are logged, never thrown.
 */
type TickTask = { everyMs: number; run: (now: Date) => unknown; lastAt: number | null };
const tasks = () => processSingleton<Map<string, TickTask>>("dispatcher_tick_tasks", () => new Map());

export function registerDispatcherTask(name: string, everyMs: number, run: (now: Date) => unknown) {
  tasks().set(name, { everyMs, run, lastAt: null });
}

function runTasks(now: Date) {
  for (const [name, t] of tasks()) {
    if (t.lastAt !== null && now.getTime() - t.lastAt < t.everyMs) continue;
    t.lastAt = now.getTime();
    try {
      t.run(now);
    } catch (e) {
      console.error(`[jarvis] dispatcher task ${name} failed`, (e as Error).message.slice(0, 200));
    }
  }
}

/** One dispatch pass (exported for tests). Never throws. */
export async function dispatchOnce(now = new Date()) {
  const s = state();
  if (s.running) return { skipped: "busy" as const };
  runTasks(now);
  // Retention runs here (hourly) whether or not the general worker is enabled.
  maybePurge(s, now);
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

const PURGE_EVERY_MS = 60 * 60_000;

/** Dismissed captures past 30 days are deleted in batches (one batch per hour keeps each tick short). */
function maybePurge(s: DispatcherState, now: Date) {
  if (s.lastPurgeAt && now.getTime() - s.lastPurgeAt < PURGE_EVERY_MS) return;
  s.lastPurgeAt = now.getTime();
  try {
    const r = purgeDismissedCaptures(now);
    // A full batch means more are waiting: come back on the next tick instead of in an hour.
    if (r.entries >= 100) s.lastPurgeAt = null;
  } catch (e) {
    console.error("[jarvis] capture purge failed", (e as Error).message.slice(0, 200));
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
