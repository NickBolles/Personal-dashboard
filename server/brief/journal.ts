import "server-only";
import { desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { addDays } from "@/lib/time";

/**
 * Check-in journal: Jarvis only ever held today's Daily Compass answer (one
 * snapshot, overwritten each day). The brief needs to look back ("yesterday you
 * named X as today's one thing"), so each day's validated answer is copied here
 * when it is read. Nothing is invented: only what the check-in recorded.
 */

const T = schema.compassEntries;

export type JournalEntry = { date: string; summary?: string; priorities: string[]; tomorrow?: string };
type Recorded = { date: string; completed: boolean; summary?: string; priorities?: string[]; tomorrow?: string };

const clean = (s: string | undefined, max: number) => (s?.trim() ? s.trim().slice(0, max) : null);

/**
 * Idempotent: writes only when the day's recorded content changed. A later empty answer never erases an
 * earlier one. The summary is kept only once the check-in is complete: before that it is a status line
 * ("not checked in yet"), not something the person said.
 */
export function journalCompass(state: Recorded) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.date)) return false;
  const summary = state.completed ? clean(state.summary, 500) : null;
  const tomorrow = clean(state.tomorrow, 200);
  const list = (state.priorities ?? [])
    .map((p) => p.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 5);
  const priorities = list.length ? JSON.stringify(list) : null;
  if (!summary && !tomorrow && !priorities) return false;
  const db = getDb();
  const row = db.select().from(T).where(eq(T.date, state.date)).get();
  const next = { summary: summary ?? row?.summary ?? null, priorities: priorities ?? row?.priorities ?? null, tomorrow: tomorrow ?? row?.tomorrow ?? null };
  if (row && row.summary === next.summary && row.priorities === next.priorities && row.tomorrow === next.tomorrow) return false;
  const journaledAt = new Date().toISOString();
  db.insert(T)
    .values({ date: state.date, ...next, journaledAt })
    .onConflictDoUpdate({ target: T.date, set: { ...next, journaledAt } })
    .run();
  return true;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Journaled days from the last `days` days up to and including `today`, newest first. */
export function recentJournal(today: string, days = 14): JournalEntry[] {
  return getDb()
    .select()
    .from(T)
    .where(gte(T.date, addDays(today, -days)))
    .orderBy(desc(T.date))
    .all()
    .filter((r) => r.date <= today && (r.summary || r.priorities || r.tomorrow))
    .map((r) => ({
      date: r.date,
      ...(r.summary ? { summary: r.summary } : {}),
      priorities: parseList(r.priorities),
      ...(r.tomorrow ? { tomorrow: r.tomorrow } : {}),
    }));
}
