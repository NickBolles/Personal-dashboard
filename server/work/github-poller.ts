import "server-only";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { processSingleton } from "@/server/singleton";
import { boundedAll } from "@/server/http/fetch";
import { claimCutoff, dueForRefresh } from "./refresh-rules";
import { POLL_LINK_MIN_INTERVAL_MS, POLL_MAX_LINKS, POLL_PARALLELISM, POLL_WAKE_MS, pollDue } from "./github-rules";
import { backoffUntil, fetchAssignedIssues, githubRefreshEnabled, storedConnections } from "./github";
import { pollMinutes } from "./github-connections";
import { syncAssignedIssues } from "./inbox";
import { readBack } from "./store";

/**
 * The Work GitHub poller (docs/work.md): a small, self-contained scheduler,
 * NOT the general worker (which stays disabled in production). Started from
 * instrumentation.ts, and again whenever a connection or the interval is
 * saved, but it only runs while a GitHub connection exists and
 * `work.github.poll_minutes` (default 10) is above 0. One per process
 * (server/singleton.ts). Each tick reads at most 50 due links (per-link
 * minimum interval 5 min, 4 requests in flight), applies changes through the
 * idempotent phase-2 refresh code, and pulls issues assigned to each
 * connection's user into that person's Work inbox. Tokens rate-limited by
 * GitHub (403/429) are skipped until their backoff ends. Read-only.
 */

type PollerState = {
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastTickAt: number | null;
  lastResult: string | null;
};
const state = () => processSingleton<PollerState>("work_github_poller", () => ({ timer: null, running: false, lastTickAt: null, lastResult: null }));

export type PollResult = {
  links: { checked: number; changed: number; errors: number };
  issues: { connections: number; synced: number; skipped: number; errors: number };
};

/** Should the poller be armed at all? */
export function pollerConfigured() {
  return githubRefreshEnabled() && pollMinutes() > 0;
}

/** One tick (exported for tests). Never throws: failures are counted. */
export async function pollTick(now = new Date()): Promise<PollResult> {
  const db = getDb();
  const L = schema.workLinks;
  const T = schema.workItems;
  const rows = db
    .select({ link: L, owner: T.userId })
    .from(L)
    .innerJoin(T, eq(T.id, L.itemId))
    .where(and(inArray(L.kind, ["github_pr", "github_issue"]), eq(T.archived, false)))
    .all();
  const due = dueForRefresh(
    rows.map((r) => r.link),
    now,
    { intervalMs: POLL_LINK_MIN_INTERVAL_MS, max: POLL_MAX_LINKS },
  );
  const cutoff = claimCutoff(now, POLL_LINK_MIN_INTERVAL_MS);
  // Claim first (conditional on checked_at) so a concurrent view-triggered refresh never reads the same link.
  const claimed = due.filter(
    (id) =>
      db
        .update(L)
        .set({ checkedAt: now.toISOString() })
        .where(and(eq(L.id, id), or(isNull(L.checkedAt), lt(L.checkedAt, cutoff))))
        .run().changes === 1,
  );
  const byId = new Map(rows.map((r) => [r.link.id, r]));
  const correlationId = newId("poll");
  const results = await boundedAll(
    claimed.map((id) => async () => {
      const r = byId.get(id)!;
      const after = await readBack({ id: r.owner }, r.link, correlationId, "github");
      return after.externalState !== r.link.externalState;
    }),
    POLL_PARALLELISM,
  );
  const links = {
    checked: claimed.length,
    changed: results.filter((r) => r.status === "fulfilled" && r.value).length,
    errors: results.filter((r) => r.status === "rejected").length,
  };

  const issues = { connections: 0, synced: 0, skipped: 0, errors: 0 };
  for (const conn of storedConnections()) {
    issues.connections++;
    if (backoffUntil(`conn:${conn.id}`, now.getTime())) {
      issues.skipped++;
      continue;
    }
    try {
      const list = await fetchAssignedIssues(conn);
      issues.synced += syncAssignedIssues(conn, list);
    } catch {
      issues.errors++;
    }
  }
  return { links, issues };
}

async function wake() {
  const s = state();
  if (s.running) return;
  if (!pollerConfigured()) {
    stopWorkGithubPoller();
    return;
  }
  const now = Date.now();
  if (!pollDue(s.lastTickAt, now, pollMinutes())) return;
  s.running = true;
  s.lastTickAt = now;
  try {
    const r = await pollTick(new Date(now));
    s.lastResult = `${r.links.checked} links read (${r.links.changed} changed, ${r.links.errors} failed); ${r.issues.synced} assigned issues from ${r.issues.connections} connections`;
  } catch (e) {
    s.lastResult = `Failed: ${(e as Error).message}`;
  } finally {
    s.running = false;
  }
}

/** Arm the poller if a connection exists and polling is on. Idempotent; never starts the general worker. */
export function startWorkGithubPoller() {
  const s = state();
  if (s.timer || !pollerConfigured()) return false;
  s.timer = setInterval(() => void wake(), POLL_WAKE_MS);
  s.timer.unref?.();
  // First tick soon after start (not during boot).
  setTimeout(() => void wake(), 5_000).unref?.();
  return true;
}

export function stopWorkGithubPoller() {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

export function pollerStatus() {
  const s = state();
  return { running: !!s.timer, lastTickAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null, lastResult: s.lastResult };
}
