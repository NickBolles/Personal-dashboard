import "server-only";
import { and, eq, isNull, ne, notLike, or } from "drizzle-orm";
import { processSingleton } from "@/server/singleton";
import { getDb, schema } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { areaDefaultsFor } from "@/server/references";
import { listItems } from "./store";
import { registerAgentRun, finishRegisteredRun } from "./registered-runs";
import type { ExecutionRecord, ExecState } from "@/lib/chat-execution";

/** Prefix of agent_runs.delegation_id rows Jarvis created itself from a conversation's sub-agents. */
export const AUTO_RUN_PREFIX = "sub:";
const MAX_PER_CALL = 20;

const runState = (s: ExecState): "running" | "waiting" | "done" | "failed" | null =>
  s === "running" ? "running" : s === "waiting" ? "waiting" : s === "completed" ? "done" : s === "failed" || s === "cancelled" ? "failed" : null;

const when = (iso: string | null | undefined, fallback: Date) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t <= fallback.getTime() ? new Date(t) : fallback;
};

/** The item a filed conversation works for: the item it sits under (an area for coordinator threads). */
export function conversationItem(user: CurrentUser, sessionId: string): string | null {
  const where = areaDefaultsFor(user, sessionId);
  if (!where) return null;
  const items = listItems(user.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const node = byId.get(where.nodeId);
  const target = node?.kind === "conversation" ? (node.parentId ? byId.get(node.parentId) : undefined) : node;
  if (!target || target.archived || target.settings?.aiPolicy === "excluded") return null;
  return target.id;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const norm = (t: string | null | undefined) =>
  (t ?? "")
    .replace(/^subagent:\s*/i, "")
    .trim()
    .toLowerCase();

/**
 * A background delegate_task saves one record per sub-agent (`sa-…` handle, state running) and Hermes' session
 * list later reports each child SESSION as its own record (child session id, no delegation/handle, state unknown,
 * `endedAt` once it closed). Nothing else ties the two together, so the dispatch record never finished and its
 * mirror showed Stalled forever. Pair them (same parent; same goal title, else the only child session that
 * started within 2 min of the dispatch) and let the child session's liveness/end close the dispatch record.
 */
export function linkChildSessions(subs: ExecutionRecord[]): ExecutionRecord[] {
  const dispatch = subs.filter((r) => !r.childSessionId && (r.subagentId || r.delegationId) && !TERMINAL.has(r.state));
  const orphans = subs.filter((r) => r.childSessionId && r.id === r.childSessionId && !r.delegationId && !r.subagentId);
  if (!dispatch.length || !orphans.length) return subs;
  const used = new Set<string>();
  const merged = new Map<string, ExecutionRecord>();
  const near = (d: ExecutionRecord, c: ExecutionRecord) => {
    const a = ms(d.startedAt);
    const b = ms(c.startedAt);
    return Number.isFinite(a) && Number.isFinite(b) && b >= a - 5_000 && b <= a + 120_000;
  };
  const pair = (d: ExecutionRecord, c: ExecutionRecord) => {
    used.add(c.id);
    const ended = !!c.endedAt;
    merged.set(d.key, {
      ...d,
      childSessionId: c.childSessionId,
      state: ended ? (c.error ? "failed" : "completed") : d.state,
      endedAt: ended ? c.endedAt : d.endedAt,
      error: ended && c.error ? c.error : d.error,
      updatedAt: (c.updatedAt ?? "") > (d.updatedAt ?? "") ? c.updatedAt : d.updatedAt,
    });
  };
  const ordered = [...dispatch].sort((x, y) => (x.startedAt ?? "").localeCompare(y.startedAt ?? "") || x.id.localeCompare(y.id));
  // 1) Title matches first, across all dispatches, so a fallback can never take another task's child.
  for (const d of ordered) {
    const byTitle = orphans.filter((c) => !used.has(c.id) && near(d, c) && norm(c.title) && norm(c.title) === norm(d.title));
    if (byTitle.length === 1) pair(d, byTitle[0]!);
  }
  // 2) Time-only fallback: exactly one unpaired dispatch and one free child in the window, and the
  // child's title names no other dispatch.
  const titles = new Set(dispatch.map((d) => norm(d.title)).filter(Boolean));
  for (const d of ordered) {
    if (merged.has(d.key)) continue;
    const free = orphans.filter((c) => !used.has(c.id) && near(d, c) && !(norm(c.title) && titles.has(norm(c.title)) && norm(c.title) !== norm(d.title)));
    if (free.length !== 1) continue;
    const rivals = ordered.filter((o) => o !== d && !merged.has(o.key) && near(o, free[0]!));
    if (rivals.length) continue;
    pair(d, free[0]!);
  }
  return subs.filter((r) => !used.has(r.id) || !orphans.includes(r)).map((r) => merged.get(r.key) ?? r);
}

/** Sessions whose last sync stopped at the write cap with records left over (the reconcile requeues them). */
const capped = () => processSingleton<Set<string>>("delegated_runs_capped", () => new Set());
/** True once per session whose last `syncDelegatedRuns` hit the write cap; clears the flag. */
export function takeCapped(userId: string, parentSessionId: string) {
  return capped().delete(`${userId}:${parentSessionId}`);
}

/** Mirror key: namespaced by the parent conversation so two conversations reporting the same child handle stay two runs. */
export const mirrorKey = (parentSessionId: string, recordId: string) => `${AUTO_RUN_PREFIX}${parentSessionId}:${recordId}`.slice(0, 200);

/**
 * Coordinator parity (board 1A): every delegate_task sub-agent Jarvis sees in a FILED conversation becomes an
 * agent run on the conversation's item, so it shows on the item, the Agents strip and the Resume hub even when
 * the agent never called jarvis_run_start. Idempotent (delegation id `sub:<parent>:<record id>`; rows written
 * before #251 used `sub:<record id>` and are adopted), skipped when the agent registered the same
 * delegation/child itself (also when that registration arrives after the mirror: the mirror is then removed),
 * and state + liveness follow the execution record.
 */
export function syncDelegatedRuns(user: CurrentUser, parentSessionId: string, profile: string | null, records: ExecutionRecord[], now = new Date()) {
  const subs = linkChildSessions(records.filter((r) => r.source === "subagent"));
  capped().delete(`${user.id}:${parentSessionId}`);
  if (!subs.length) return 0;
  const itemId = conversationItem(user, parentSessionId);
  if (!itemId) return 0;
  const db = getDb();
  const T = schema.agentRuns;
  const who = profile ?? "default";
  let changed = 0;
  for (const r of subs) {
    // The cap bounds WRITES per call, so records already mirrored never starve newer ones.
    if (changed >= MAX_PER_CALL) {
      capped().add(`${user.id}:${parentSessionId}`);
      break;
    }
    const key = mirrorKey(parentSessionId, r.id);
    let own = db
      .select()
      .from(T)
      .where(and(eq(T.userId, user.id), eq(T.delegationId, key)))
      .get();
    if (!own) {
      // Pre-#251 mirror key, same item: adopt it under the namespaced key.
      const legacy = db
        .select()
        .from(T)
        .where(and(eq(T.userId, user.id), eq(T.delegationId, `${AUTO_RUN_PREFIX}${r.id}`.slice(0, 200)), eq(T.itemId, itemId), isNull(T.tokenId)))
        .get();
      if (legacy) {
        db.update(T).set({ delegationId: key }).where(eq(T.id, legacy.id)).run();
        own = { ...legacy, delegationId: key };
      }
    }
    // The agent registered it itself (same delegation or child session): don't double count.
    const match = [
      r.delegationId ? eq(T.delegationId, r.delegationId) : undefined,
      r.delegationId ? eq(T.delegationId, `${r.delegationId}:${r.id}`) : undefined,
      r.subagentId && r.delegationId ? eq(T.delegationId, `${r.delegationId}:${r.subagentId}`) : undefined,
      r.childSessionId ? eq(T.hermesSessionId, r.childSessionId) : undefined,
    ].filter((c) => c !== undefined);
    const theirs = match.length
      ? db
          .select({ id: T.id })
          .from(T)
          .where(
            and(
              eq(T.userId, user.id),
              own ? ne(T.id, own.id) : undefined,
              or(isNull(T.delegationId), notLike(T.delegationId, `${AUTO_RUN_PREFIX}%`)),
              or(...match),
            ),
          )
          .get()
      : undefined;
    const next = runState(r.state);
    // Historical results keep their own times, so an old failure never looks newer than a later success.
    const startedAt = when(r.startedAt, now);
    const finishedAt = when(r.endedAt ?? r.updatedAt, now);
    if (own) {
      if (own.tokenId !== null) continue;
      if (theirs) {
        // A jarvis_run_start registration arrived after the automatic mirror: keep only theirs.
        db.delete(T).where(eq(T.id, own.id)).run();
        changed++;
        continue;
      }
      if (next && own.state !== next && !(own.state === "done" || own.state === "failed")) {
        finishRegisteredRun(
          user,
          own.id,
          next,
          (r.summary ?? r.error ?? (next === "done" ? "Finished" : next === "failed" ? "Failed" : "Running")).slice(0, 2000),
          next === "running" || next === "waiting" ? now : finishedAt,
        );
        changed++;
      } else if ((own.state === "running" || own.state === "waiting") && own.state === next && r.updatedAt) {
        // Same state but the child reported newer activity: carry the heartbeat, so a live
        // sub-agent isn't shown as Stalled after 30 min.
        const seen = when(r.updatedAt, now).toISOString();
        if (seen > own.updatedAt) {
          db.update(T)
            .set({ updatedAt: seen, ...(r.summary ? { summary: r.summary.slice(0, 2000) } : {}) })
            .where(eq(T.id, own.id))
            .run();
          changed++;
        }
      }
      continue;
    }
    // Children identified only by Hermes' sub-agent handle (subagent.start without delegation/child session) count too.
    if (!(r.delegationId || r.childSessionId || r.subagentId)) continue;
    // Unknown state: wait until the transcript says running/finished instead of guessing "running".
    if (theirs || !next) continue;
    const { runId } = registerAgentRun(
      user,
      who,
      {
        itemId,
        title: (r.title || "Delegated task").slice(0, 200),
        hermesSessionId: r.childSessionId ?? parentSessionId,
        delegationId: key,
        ...(r.transcriptPath ? { transcriptPath: r.transcriptPath.slice(0, 500) } : {}),
      },
      `exec:${parentSessionId}`.slice(0, 120),
      null,
      startedAt,
    );
    changed++;
    if (next !== "running") finishRegisteredRun(user, runId, next, (r.summary ?? r.error ?? "").slice(0, 2000), next === "waiting" ? now : finishedAt);
  }
  return changed;
}
