import "server-only";
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { userById, type CurrentUser } from "@/server/auth";
import { processSingleton } from "@/server/singleton";
import { readIndex } from "./conversation-index";

/**
 * Background reconcile for coordinator parity: sub-agents become agent runs on their item even when nobody
 * has the conversation open. The dispatcher tick picks recently active FILED conversations (last 24 h in the
 * person's conversation index) plus filed conversations that still have an in-flight child, and runs the same
 * bounded transcript parse + mirror the chat page's execution panel runs (server/chat/execution.ts).
 * Bounded (≤20 sessions per tick, one at a time), idempotent (delegated-runs dedupes by delegation id) and
 * skips a session whose activity marker hasn't moved since its last pass.
 */
export const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;
export const RECONCILE_MAX_PER_TICK = 20;
/** an in-flight child with no new parent activity is re-read at most this often */
const ACTIVE_RECHECK_MS = 15 * 60_000;

type Candidate = { user: CurrentUser; sessionId: string; marker: string; at: number };
type State = { seen: Map<string, string>; busy: boolean };
const state = () => processSingleton<State>("coordinator_run_reconcile", () => ({ seen: new Map(), busy: false }));

const ACTIVE_STATES = ["running", "waiting", "unknown"] as const;

export function reconcileCandidates(now = new Date(), limit = RECONCILE_MAX_PER_TICK): Candidate[] {
  const db = getDb();
  const W = schema.workItems;
  const since = now.getTime() - RECONCILE_WINDOW_MS;
  const filed = db
    .select({ userId: W.userId, sessionId: W.sessionId })
    .from(W)
    .where(and(eq(W.kind, "conversation"), eq(W.archived, false), isNotNull(W.sessionId)))
    .all();
  const byUser = new Map<string, Set<string>>();
  for (const r of filed) if (r.sessionId) byUser.set(r.userId, (byUser.get(r.userId) ?? new Set()).add(r.sessionId));
  const seen = state().seen;
  const out: Candidate[] = [];
  for (const [userId, sessions] of byUser) {
    const user = userById(userId);
    if (!user || !user.capabilities.has("work.use") || !user.capabilities.has("hermes.chat")) continue;
    const picked = new Map<string, Candidate>();
    for (const s of readIndex(userId)?.sessions ?? []) {
      const iso = s.lastActiveAt ?? s.startedAt;
      const at = iso ? Date.parse(iso) : NaN;
      if (!sessions.has(s.id) || !Number.isFinite(at) || at < since) continue;
      picked.set(s.id, { user, sessionId: s.id, marker: `a:${iso}`, at });
    }
    const ids = [...sessions];
    const active = ids.length
      ? db
          .select({ sessionId: schema.chatExecRecords.parentSessionId, updatedAt: schema.chatExecRecords.updatedAt })
          .from(schema.chatExecRecords)
          .where(
            and(
              inArray(schema.chatExecRecords.parentSessionId, ids.slice(0, 500)),
              inArray(schema.chatExecRecords.state, [...ACTIVE_STATES]),
              gte(schema.chatExecRecords.updatedAt, new Date(since).toISOString()),
            ),
          )
          .all()
      : [];
    const bucket = Math.floor(now.getTime() / ACTIVE_RECHECK_MS);
    for (const r of active) {
      if (picked.has(r.sessionId)) continue;
      const at = Date.parse(r.updatedAt);
      picked.set(r.sessionId, { user, sessionId: r.sessionId, marker: `r:${bucket}`, at: Number.isFinite(at) ? at : since });
    }
    for (const c of picked.values()) if (seen.get(`${userId}:${c.sessionId}`) !== c.marker) out.push(c);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * One reconcile pass. Never blocks the tick: work runs in the background, one session at a time, and a pass
 * that is still running makes the next tick a no-op. `read` is the chat page's execution read (injectable for tests).
 */
export function reconcileDelegatedRuns(
  now = new Date(),
  read: (user: CurrentUser, sessionId: string) => Promise<unknown> = defaultRead,
): { queued: number; done: Promise<void> } {
  const s = state();
  if (s.busy) return { queued: 0, done: Promise.resolve() };
  const list = reconcileCandidates(now);
  if (!list.length) return { queued: 0, done: Promise.resolve() };
  s.busy = true;
  const done = (async () => {
    try {
      for (const c of list) {
        // Marked before the read: a failing session is retried only once its activity moves.
        s.seen.set(`${c.user.id}:${c.sessionId}`, c.marker);
        try {
          await read(c.user, c.sessionId);
        } catch {
          // best effort (session gone, Hermes down): the page read retries it on open
        }
      }
      if (s.seen.size > 2000) for (const k of [...s.seen.keys()].slice(0, s.seen.size - 2000)) s.seen.delete(k);
    } finally {
      s.busy = false;
    }
  })();
  return { queued: list.length, done };
}

async function defaultRead(user: CurrentUser, sessionId: string) {
  const { chatExecution } = await import("@/server/chat/execution");
  return chatExecution(user, sessionId);
}

/** tests only */
export function __resetReconcile() {
  const s = state();
  s.seen.clear();
  s.busy = false;
}
