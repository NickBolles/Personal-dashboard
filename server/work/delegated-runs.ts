import "server-only";
import { and, eq, or } from "drizzle-orm";
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

/**
 * Coordinator parity (board 1A): every delegate_task sub-agent Jarvis sees in a FILED conversation becomes an
 * agent run on the conversation's item, so it shows on the item, the Agents strip and the Resume hub even when
 * the agent never called jarvis_run_start. Idempotent (delegation id `sub:<record id>`), skipped when the
 * agent registered the same delegation/child itself, and state follows the execution record.
 */
export function syncDelegatedRuns(user: CurrentUser, parentSessionId: string, profile: string | null, records: ExecutionRecord[], now = new Date()) {
  const subs = records.filter((r) => r.source === "subagent");
  if (!subs.length) return 0;
  const itemId = conversationItem(user, parentSessionId);
  if (!itemId) return 0;
  const db = getDb();
  const T = schema.agentRuns;
  const who = profile ?? "default";
  let changed = 0;
  for (const r of subs) {
    // The cap bounds WRITES per call, so records already mirrored never starve newer ones.
    if (changed >= MAX_PER_CALL) break;
    const key = `${AUTO_RUN_PREFIX}${r.id}`.slice(0, 200);
    const own = db
      .select()
      .from(T)
      .where(and(eq(T.userId, user.id), eq(T.delegationId, key)))
      .get();
    const next = runState(r.state);
    // Historical results keep their own times, so an old failure never looks newer than a later success.
    const startedAt = when(r.startedAt, now);
    const finishedAt = when(r.endedAt ?? r.updatedAt, now);
    if (own) {
      if (own.tokenId === null && next && own.state !== next && !(own.state === "done" || own.state === "failed")) {
        finishRegisteredRun(
          user,
          own.id,
          next,
          (r.summary ?? r.error ?? (next === "done" ? "Finished" : next === "failed" ? "Failed" : "Running")).slice(0, 2000),
          next === "running" || next === "waiting" ? now : finishedAt,
        );
        changed++;
      }
      continue;
    }
    if (!(r.delegationId || r.childSessionId)) continue;
    // The agent registered it itself (same delegation or child session): don't double count.
    const theirs = db
      .select({ id: T.id })
      .from(T)
      .where(
        and(
          eq(T.userId, user.id),
          or(
            r.delegationId ? eq(T.delegationId, r.delegationId) : undefined,
            r.delegationId ? eq(T.delegationId, `${r.delegationId}:${r.id}`) : undefined,
            r.childSessionId ? eq(T.hermesSessionId, r.childSessionId) : undefined,
          ),
        ),
      )
      .get();
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
