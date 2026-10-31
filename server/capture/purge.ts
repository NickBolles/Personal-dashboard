import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { config } from "@/server/config";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";

// Kept free of AI/work imports: the push dispatcher (reachable from server/ai) calls it.
const I = schema.workInbox;
const A = schema.captureAttachments;

/** Owner decision 2026-10-25: dismissed captures (and their attachments and reports) are deleted after 30 days. */
export const DISMISSED_CAPTURE_RETENTION_DAYS = 30;

/**
 * Delete dismissed, never-filed captures older than the retention window, in batches.
 * Their attachment files, attachment rows, inbox-scoped AI reports and the alerts that link to them go too; the
 * ai_jobs spend ledger stays with its capture-derived params (e.g. the investigation brief) cleared. Audited per entry (ids only), one correlation id per batch.
 * Called from the standalone dispatcher tick (hourly), so it runs with the worker off.
 */
export function purgeDismissedCaptures(now = new Date(), limit = 100) {
  const db = getDb();
  const cutoff = new Date(now.getTime() - DISMISSED_CAPTURE_RETENTION_DAYS * 86400_000).toISOString();
  const rows = db
    .select({ id: I.id })
    .from(I)
    .where(and(eq(I.source, "capture"), isNotNull(I.dismissedAt), lt(I.dismissedAt, cutoff), isNull(I.acceptedAt)))
    .limit(limit)
    .all();
  if (!rows.length) return { entries: 0, attachments: 0, reports: 0, notifications: 0 };
  const ids = rows.map((r) => r.id);
  const files = db.select({ storageKey: A.storageKey }).from(A).where(inArray(A.inboxId, ids)).all();
  const R = schema.aiReports;
  let reports = 0;
  let notifications = 0;
  db.transaction((tx) => {
    reports = tx
      .delete(R)
      .where(and(eq(R.subjectType, "inbox"), inArray(R.subjectId, ids)))
      .run().changes;
    tx.update(schema.aiJobs)
      .set({ reportId: null, params: "{}" })
      .where(and(eq(schema.aiJobs.subjectType, "inbox"), inArray(schema.aiJobs.subjectId, ids)))
      .run();
    // Report ready / failed alerts copy the capture title and report summary: they go too (pending pushes included).
    notifications = tx
      .delete(schema.notifications)
      .where(
        inArray(
          schema.notifications.deepLink,
          ids.flatMap((id) => [`/inbox?entry=${encodeURIComponent(id)}`, `/areas?view=inbox&entry=${encodeURIComponent(id)}`]),
        ),
      )
      .run().changes;
    tx.delete(A).where(inArray(A.inboxId, ids)).run();
    tx.delete(I).where(inArray(I.id, ids)).run();
  });
  // Files after the rows: a failed unlink leaves an orphan file, never a row pointing at nothing.
  const dir = path.join(config.dataDir, "captures");
  for (const f of files)
    try {
      fs.unlinkSync(path.join(dir, f.storageKey));
    } catch {
      /* already gone */
    }
  // One audit row per purged entry (ids are long enough that the batch detail would redact them), one correlation id per batch.
  const correlationId = newId("purge");
  for (const id of ids)
    audit({
      actor: "jarvis",
      action: "capture.purge_dismissed",
      source: "capture",
      sourceRecord: id,
      result: "ok",
      correlationId,
      detail: { olderThanDays: DISMISSED_CAPTURE_RETENTION_DAYS, batch: ids.length },
    });
  return { entries: ids.length, attachments: files.length, reports, notifications };
}
