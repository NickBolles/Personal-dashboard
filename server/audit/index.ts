import "server-only";
import { desc } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";

export type AuditEntry = {
  actor: string;
  action: string;
  source?: string;
  sourceRecord?: string;
  result: "ok" | "error" | "rejected" | "pending";
  correlationId: string;
  detail?: Record<string, unknown>;
};

const SECRET_KEYS = /token|secret|password|passcode|authorization|api[_-]?key|cookie/i;

/** Remove anything that looks like a credential before persisting. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && /^(Bearer\s+)?[A-Za-z0-9_\-.]{40,}$/.test(value)) return "[redacted]";
  return value;
}

export function audit(entry: AuditEntry) {
  getDb()
    .insert(schema.auditLog)
    .values({
      id: newId(),
      actor: entry.actor,
      action: entry.action,
      source: entry.source,
      sourceRecord: entry.sourceRecord,
      result: entry.result,
      correlationId: entry.correlationId,
      detail: entry.detail ? JSON.stringify(redact(entry.detail)) : null,
    })
    .run();
}

export function recentAudit(limit = 100) {
  return getDb().select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(limit).all();
}
