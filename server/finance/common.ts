import "server-only";
import { and, eq, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { getPreferences, getSetting, setSetting } from "@/server/settings";
import { localDate } from "@/lib/time";
import type { ReserveSettings } from "@/lib/finance/types";

export const FINANCE_SETTINGS_KEY = "finance_settings";

export const DEFAULT_FINANCE_SETTINGS: ReserveSettings = { mode: "additive", horizonDays: 30, cushion: null, staleHours: 24 };

export function financeSettings(): ReserveSettings {
  return { ...DEFAULT_FINANCE_SETTINGS, ...(getSetting<Partial<ReserveSettings>>(FINANCE_SETTINGS_KEY) ?? {}) };
}

export function saveFinanceSettings(patch: Partial<ReserveSettings>, actor: string, correlationId: string) {
  const before = financeSettings();
  const after = { ...before, ...patch };
  setSetting(FINANCE_SETTINGS_KEY, after);
  auditFinance(actor, "finance.settings", undefined, before, after, correlationId);
  return after;
}

export const tz = () => getPreferences().timezone;
export const today = (now = new Date()) => localDate(now, tz());
export const thisMonth = (now = new Date()) => today(now).slice(0, 7);

export function conflict(): never {
  throw new HttpError(409, "version_conflict", "Someone else changed this just now. Reload to see their change, then try again.");
}

export function notFound(what: string): never {
  throw new HttpError(404, "not_found", `${what} not found`);
}

/**
 * Optimistic concurrency: update only if the row still has the version the
 * caller saw, and bump it. Anything else is a 409.
 */
export function updateVersioned<T extends SQLiteTable & { version: SQLiteColumn }>(
  table: T,
  where: SQL,
  version: number,
  set: Record<string, unknown>,
  db = getDb(),
) {
  const res = db
    .update(table)
    .set({ ...set, version: version + 1 } as never)
    .where(and(where, eq(table.version, version)))
    .run();
  if (res.changes === 0) conflict();
}

/** Every finance write is audited with who, when, before and after. */
export function auditFinance(actor: string, action: string, record: string | undefined, before: unknown, after: unknown, correlationId: string) {
  audit({ actor, action, source: "finance", sourceRecord: record, result: "ok", correlationId, detail: { before: before ?? null, after: after ?? null } });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthName(month: string) {
  return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
}
