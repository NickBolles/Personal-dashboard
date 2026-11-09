import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, isNull, notLike, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { processSingleton } from "@/server/singleton";
import { AUTO_RUN_PREFIX } from "./delegated-runs";
import { recordRunTransition } from "./run-events";

/**
 * CW-2/CW-5: a run whose coordinator session ended is `interrupted` (not failed): it can be resumed.
 * The reconcile tick asks Hermes for each open run's session (one GET per session, never the list) and
 * marks the run interrupted when the session has an end reason that really stops the conversation and
 * the run sent no heartbeat after that. Bounded: at most SESSIONS_PER_PASS sessions every CHECK_EVERY_MS.
 * Automatic sub-agent mirrors (`sub:` delegations) are left to the mirror reconcile.
 */
export const CHECK_EVERY_MS = 5 * 60_000;
export const SESSIONS_PER_PASS = 10;
/** a heartbeat this long after the session's last activity means the agent is alive somewhere else */
const HEARTBEAT_GRACE_MS = 2 * 60_000;
/**
 * Hermes closes an idle agent between turns (`agent_close`, recoverable: the next message reopens it), so a
 * session counts as ended only after it has been quiet this long; a reopened session has no end reason.
 */
export const QUIET_MS = 10 * 60_000;
/** older open runs are left alone (no surprise back-fill of historic rows on the first pass) */
export const LOOKBACK_MS = 3 * 24 * 60 * 60_000;
/** Hermes end reasons after which the conversation goes on (compression child, fork, adoption, resume/repair). */
export const CONTINUED_END_REASONS = new Set(["compression", "branched", "adopted_by_profile", "superseded_by_resume", "superseded_by_repair"]);

export type SessionState = { endReason?: string | null; lastActiveAt?: string | null };
export type SessionLookup = (profile: string | null, sessionId: string) => Promise<SessionState | null>;

/** The session really ended (not continued elsewhere). */
export function sessionEnded(s: SessionState | null): s is SessionState & { endReason: string } {
  return !!s?.endReason && !CONTINUED_END_REASONS.has(s.endReason);
}

const profileOf = (p: string) => (!p || p === "default" ? null : p);
const state = () =>
  processSingleton<{ at: number; busy: boolean; checked: Map<string, number> }>("cw_session_end", () => ({ at: 0, busy: false, checked: new Map() }));

/** One bounded pass. Returns how many sessions were checked and runs marked. */
export async function markEndedSessionRuns(now = new Date(), lookup: SessionLookup = defaultLookup): Promise<{ checked: number; marked: number }> {
  const s = state();
  if (s.busy || now.getTime() - s.at < CHECK_EVERY_MS) return { checked: 0, marked: 0 };
  s.at = now.getTime();
  s.busy = true;
  try {
    return await pass(now, lookup);
  } finally {
    s.busy = false;
  }
}

/** Test hook: forget the throttle. */
export function __resetSessionEnd() {
  const s = state();
  s.at = 0;
  s.busy = false;
  s.checked.clear();
}

async function pass(now: Date, lookup: SessionLookup) {
  const db = getDb();
  const T = schema.agentRuns;
  const open = db
    .select()
    .from(T)
    .where(
      and(
        inArray(T.state, ["running", "waiting"]),
        isNotNull(T.hermesSessionId),
        gte(T.updatedAt, new Date(now.getTime() - LOOKBACK_MS).toISOString()),
        or(isNull(T.delegationId), notLike(T.delegationId, `${AUTO_RUN_PREFIX}%`)),
      ),
    )
    // least recently heard from first: those are the likeliest to have lost their session
    .orderBy(asc(T.updatedAt))
    .limit(200)
    .all();
  const bySession = new Map<string, typeof open>();
  if (state().checked.size > 5000) state().checked.clear();
  for (const r of open) {
    const key = `${r.userId}|${r.profile}|${r.hermesSessionId}`;
    bySession.set(key, [...(bySession.get(key) ?? []), r]);
  }
  let checked = 0;
  let marked = 0;
  // Least recently checked sessions first (never checked = first), so a long list rotates instead of
  // re-reading the same ten every pass.
  const checkedAt = state().checked;
  const order = [...bySession.entries()].sort(([a], [b]) => (checkedAt.get(a) ?? 0) - (checkedAt.get(b) ?? 0));
  for (const [key, runs] of order.slice(0, SESSIONS_PER_PASS)) {
    const first = runs[0]!;
    checkedAt.set(key, now.getTime());
    let session: SessionState | null;
    try {
      session = await lookup(profileOf(first.profile), first.hermesSessionId!);
    } catch {
      continue; // Hermes down / profile not routed: unknown, never guessed
    }
    checked++;
    if (!sessionEnded(session)) continue;
    const endedAt = Date.parse(session.lastActiveAt ?? "");
    if (Number.isFinite(endedAt) && now.getTime() - endedAt < QUIET_MS) continue;
    for (const run of runs) {
      // A heartbeat after the session went quiet: the agent is still working (e.g. resumed in a new session).
      if (Number.isFinite(endedAt) && Date.parse(run.updatedAt) > endedAt + HEARTBEAT_GRACE_MS) continue;
      const at = now.toISOString();
      const changed = db.transaction(
        (tx) => {
          const row = tx.select().from(T).where(eq(T.id, run.id)).get();
          if (!row || (row.state !== "running" && row.state !== "waiting") || row.updatedAt !== run.updatedAt) return false;
          tx.update(T).set({ state: "interrupted", interruptedAt: at, updatedAt: at }).where(eq(T.id, row.id)).run();
          recordRunTransition(tx, row, "interrupted", `Session ended (${session.endReason})`, "jarvis");
          return true;
        },
        { behavior: "immediate" },
      );
      if (changed) marked++;
    }
  }
  return { checked, marked };
}

async function defaultLookup(profile: string | null, sessionId: string): Promise<SessionState | null> {
  const [{ HermesSessionClient }, { connForProfile }, { normalizeSession }, { sessionProfile }] = await Promise.all([
    import("@/integrations/hermes/client"),
    import("@/server/agents/routing"),
    import("@/integrations/hermes/normalize"),
    import("@/integrations/hermes/service"),
  ]);
  // A session Jarvis tracks keeps its recorded profile; an agent's own session lives on the run's profile.
  const res = await HermesSessionClient.get(connForProfile(sessionProfile(sessionId) ?? profile), sessionId);
  const s = normalizeSession(res.session);
  return { endReason: s.endReason ?? null, lastActiveAt: s.lastActiveAt ?? null };
}
