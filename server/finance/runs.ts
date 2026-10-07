import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";

/**
 * Refresh/import runs hold a lease so two can't overlap, and so taking a
 * snapshot or closing a check-in can't race one silently. A crashed run's
 * lease simply expires.
 */
const LEASE_MS = 5 * 60_000;

export function runningRun(now = new Date()) {
  return getDb()
    .select()
    .from(schema.finRuns)
    .where(and(eq(schema.finRuns.status, "running"), gt(schema.finRuns.leaseUntil, now.toISOString())))
    .get();
}

export function startRun(kind: "monarch" | "csv" | "manual", requestedBy: string) {
  const db = getDb();
  return db.transaction((tx) => {
    const now = new Date();
    const busy = tx
      .select()
      .from(schema.finRuns)
      .where(and(eq(schema.finRuns.status, "running"), gt(schema.finRuns.leaseUntil, now.toISOString())))
      .get();
    if (busy) throw new HttpError(409, "refresh_running", "A balance refresh or import is already running. Try again when it finishes.");
    // Expired leases are crashed runs: record them as failed.
    tx.update(schema.finRuns)
      .set({ status: "failed", outcome: "failed", error: "Interrupted", finishedAt: now.toISOString() })
      .where(eq(schema.finRuns.status, "running"))
      .run();
    const id = newId("frn");
    tx.insert(schema.finRuns)
      .values({ id, kind, requestedBy, status: "running", leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() })
      .run();
    return id;
  });
}

export function lastRun() {
  return getDb().select().from(schema.finRuns).orderBy(desc(schema.finRuns.startedAt), desc(schema.finRuns.id)).limit(1).get();
}

export function getRun(id: string) {
  return getDb().select().from(schema.finRuns).where(eq(schema.finRuns.id, id)).get();
}
