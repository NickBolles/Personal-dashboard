import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, like, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { userById, type CurrentUser } from "@/server/auth";
import { processSingleton } from "@/server/singleton";
import { executionRecords } from "@/server/chat/execution-store";
import { readIndex } from "./conversation-index";
import { AUTO_RUN_PREFIX, linkChildSessions, mirrorKey, runState, STALE_CHILD_MS, staleOpenRecord, takeCapped } from "./delegated-runs";
import { finishRegisteredRun } from "./registered-runs";

/**
 * Background reconcile for coordinator parity: sub-agents become agent runs on their item even when nobody
 * has the conversation open. The dispatcher tick picks recently active FILED conversations (last 24 h in the
 * person's conversation index) plus filed conversations that still have an in-flight child, and runs the same
 * bounded transcript parse + mirror the chat page's execution panel runs (server/chat/execution.ts).
 * Bounded (≤20 sessions per tick, one at a time), idempotent (delegated-runs dedupes by delegation id) and
 * skips a session whose activity marker hasn't moved since its last pass, unless its mirror hit the write cap.
 */
export const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;
export const RECONCILE_MAX_PER_TICK = 20;
/** an in-flight child with no new parent activity is re-read at most this often */
const ACTIVE_RECHECK_MS = 15 * 60_000;
/**
 * In-flight children stay eligible for the bounded recheck this long after their last update, even once the
 * parent left the 24 h activity window (that window gates recent-parent discovery only).
 */
export const ACTIVE_CHILD_WINDOW_MS = 7 * 24 * 60 * 60_000;

type Candidate = { user: CurrentUser; sessionId: string; marker: string; at: number };
type State = { seen: Map<string, string>; busy: boolean; sweptAt: number };
const state = () => processSingleton<State>("coordinator_run_reconcile", () => ({ seen: new Map(), busy: false, sweptAt: 0 }));

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
              gte(schema.chatExecRecords.updatedAt, new Date(now.getTime() - ACTIVE_CHILD_WINDOW_MS).toISOString()),
            ),
          )
          .all()
      : [];
    const bucket = Math.floor(now.getTime() / ACTIVE_RECHECK_MS);
    for (const r of active) {
      const hit = picked.get(r.sessionId);
      // An in-flight child is re-read every bucket even when the parent's activity didn't move.
      if (hit) {
        if (!hit.marker.includes("|r:")) hit.marker = `${hit.marker}|r:${bucket}`;
        continue;
      }
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
  if (!(now.getTime() - s.sweptAt < SWEEP_EVERY_MS)) {
    s.sweptAt = now.getTime();
    try {
      sweepStaleMirrors(now);
    } catch {
      // best effort: retried on the next sweep
    }
  }
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
        // The mirror stopped at its per-call write cap: requeue the session for the next tick.
        if (takeCapped(c.user.id, c.sessionId)) s.seen.delete(`${c.user.id}:${c.sessionId}`);
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

/** how often the stale-mirror sweep runs (first tick after start, then hourly) */
const SWEEP_EVERY_MS = 60 * 60_000;
const SWEEP_MAX_ROWS = 200;

/**
 * Clean-up for #258 (release 65's back-fill registered old sub-agents as `running`): open automatic mirrors
 * with no update for over a day are settled from the persisted execution records alone (no Hermes call, so it
 * also reaches conversations the reconcile no longer re-reads). Child known to have ended → the run finishes
 * with the child's state and end time; still in flight with recent activity → left alone; fate unknown →
 * the mirror is withdrawn, exactly what the fixed back-fill would have done. Token-owned registrations are
 * never touched. Idempotent: a second pass finds nothing.
 */
export function sweepStaleMirrors(now = new Date()): { closed: number; removed: number } {
  const db = getDb();
  const T = schema.agentRuns;
  const cutoff = new Date(now.getTime() - STALE_CHILD_MS).toISOString();
  const rows = db
    .select()
    .from(T)
    .where(and(isNull(T.tokenId), like(T.delegationId, `${AUTO_RUN_PREFIX}%`), inArray(T.state, ["running", "waiting"]), lt(T.updatedAt, cutoff)))
    .limit(SWEEP_MAX_ROWS)
    .all();
  const byParent = new Map<string, ReturnType<typeof linkChildSessions>>();
  const recordsOf = (parent: string) => {
    let list = byParent.get(parent);
    if (!list) {
      list = linkChildSessions(executionRecords(parent).filter((r) => r.source === "subagent"));
      byParent.set(parent, list);
    }
    return list;
  };
  let closed = 0;
  let removed = 0;
  for (const row of rows) {
    const user = userById(row.userId);
    if (!user) continue;
    const rest = row.delegationId!.slice(AUTO_RUN_PREFIX.length);
    const cut = rest.indexOf(":");
    // `sub:<parent>:<record id>`; pre-#251 keys (`sub:<record id>`) name no parent, so their fate is unknown.
    const parent = cut > 0 ? rest.slice(0, cut) : null;
    const record = parent ? recordsOf(parent).find((r) => mirrorKey(parent, r.id) === row.delegationId) : undefined;
    const next = record ? runState(record.state) : null;
    if (record && (next === "done" || next === "failed")) {
      const at = Date.parse(record.endedAt ?? record.updatedAt ?? "");
      finishRegisteredRun(
        user,
        row.id,
        next,
        (record.summary ?? record.error ?? (next === "done" ? "Finished" : "Failed")).slice(0, 2000),
        Number.isFinite(at) && at <= now.getTime() ? new Date(at) : now,
      );
      closed++;
      continue;
    }
    if (record && !staleOpenRecord(record, now)) continue;
    db.delete(T).where(eq(T.id, row.id)).run();
    removed++;
  }
  return { closed, removed };
}

/** tests only */
export function __resetReconcile() {
  const s = state();
  s.seen.clear();
  s.busy = false;
  s.sweptAt = 0;
}
