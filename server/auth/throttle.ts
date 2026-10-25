import "server-only";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { AuthError } from "./errors";

/**
 * Failed sign-in throttling, stored in SQLite so a restart doesn't reset it.
 *
 * Every guessable credential check (login, setup code, invite, pairing code,
 * passcode change) records failures against several keys at once:
 * - `ip:<scope>:<client>`  — one client (server/http/origin.ts clientIp).
 *   5 free failures, then 30 s doubling per failure, capped at 15 min.
 * - `acct:<id>`            — one account, whatever IP the guesses come from.
 *   10 free failures, then 30 s doubling, capped at 15 min.
 * - `global:<scope>`       — everyone. Past 50 failures in 15 min, only one
 *   attempt per 10 s is accepted until the window passes.
 * A success clears the client and account keys (never the global one).
 * Counters forget after an hour without failures.
 */

const MIN = 60_000;
const DECAY_MS = 60 * MIN;
const GLOBAL_WINDOW_MS = 15 * MIN;
const GLOBAL_BUDGET = 50;
const GLOBAL_SPACING_MS = 10_000;
const MAX_LOCK_MS = 15 * MIN;

type Policy = { kind: "backoff"; free: number } | { kind: "global" };

function policyFor(key: string): Policy {
  if (key.startsWith("global:")) return { kind: "global" };
  if (key.startsWith("acct:")) return { kind: "backoff", free: 10 };
  return { kind: "backoff", free: 5 };
}

export type ThrottleScope = "login" | "setup" | "join" | "pair" | "passcode";

/** Keys for one attempt: the client, optionally the target account, and the scope's global budget. */
export function throttleKeys(scope: ThrottleScope, client: string, accountId?: string) {
  return [`ip:${scope}:${client}`, ...(accountId ? [`acct:${accountId}`] : []), `global:${scope}`];
}

const asList = (k: string | string[]) => (Array.isArray(k) ? k : [k]);

export function checkThrottle(keys: string | string[], now = Date.now()) {
  const list = asList(keys);
  const rows = getDb().select().from(schema.authFailures).where(inArray(schema.authFailures.key, list)).all();
  const until = Math.max(0, ...rows.map((r) => r.lockedUntil));
  if (until > now) {
    throw new AuthError("throttled", `Too many attempts. Try again in ${Math.ceil((until - now) / 1000)}s.`);
  }
}

export function recordFailure(keys: string | string[], now = Date.now()) {
  const db = getDb();
  const T = schema.authFailures;
  db.transaction((tx) => {
    for (const key of asList(keys)) {
      const row = tx.select().from(T).where(eq(T.key, key)).get();
      const policy = policyFor(key);
      let count = row?.count ?? 0;
      let firstAt = row?.firstAt ?? now;
      if (row && policy.kind === "global" && now - row.firstAt > GLOBAL_WINDOW_MS) {
        count = 0;
        firstAt = now;
      }
      if (row && policy.kind === "backoff" && now - Math.max(row.lastAt, row.lockedUntil) > DECAY_MS) {
        count = 0;
        firstAt = now;
      }
      count += 1;
      let lockedUntil = row?.lockedUntil ?? 0;
      if (policy.kind === "global") {
        if (count >= GLOBAL_BUDGET) lockedUntil = now + GLOBAL_SPACING_MS;
      } else if (count >= policy.free) {
        lockedUntil = now + Math.min(MAX_LOCK_MS, 2 ** (count - policy.free) * 30_000);
      }
      tx.insert(T)
        .values({ key, count, firstAt, lastAt: now, lockedUntil })
        .onConflictDoUpdate({ target: T.key, set: { count, firstAt, lastAt: now, lockedUntil } })
        .run();
    }
    // Housekeeping: drop counters idle for a day.
    tx.delete(T)
      .where(and(lt(T.lastAt, now - 24 * 60 * MIN), lt(T.lockedUntil, now)))
      .run();
  });
}

/** After a success: forget this client's and account's failures (the global budget stays). */
export function clearFailures(keys: string | string[]) {
  const list = asList(keys).filter((k) => !k.startsWith("global:"));
  if (list.length) getDb().delete(schema.authFailures).where(inArray(schema.authFailures.key, list)).run();
}
