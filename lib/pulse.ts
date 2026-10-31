/**
 * Today pulse (design review: Today counts + an over-time metric). Pure helpers
 * so the trend maths is unit-testable; server/home/pulse.ts feeds them real rows.
 */

export type PulseTrend = { days: string[]; added: number[]; completed: number[] };

/** Counts are null when the person can't see that data — the KPI is hidden, never faked. */
export type HomePulse = {
  approvals: number | null;
  awaitingValidation: number | null;
  mergedNotSettled: number | null;
  /** 14 days of work added vs completed, oldest first; null without work access. */
  trend: PulseTrend | null;
};

/** YYYY-MM-DD of an instant in a time zone. */
export function dayKey(at: Date | string, timeZone: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The last `n` calendar days ending today (in `timeZone`), oldest first. */
export function lastDays(now: Date, n: number, timeZone: string): string[] {
  const end = dayKey(now, timeZone);
  const [y, m, d] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y!, m! - 1, d! - i)).toISOString().slice(0, 10));
  return out;
}

/** Work added vs completed per day from item timestamps (createdAt / completedAt). */
export function addedVsCompleted(rows: { createdAt: string | null; completedAt: string | null }[], now: Date, timeZone: string, n = 14): PulseTrend {
  const days = lastDays(now, n, timeZone);
  const idx = new Map(days.map((d, i) => [d, i]));
  const added = days.map(() => 0);
  const completed = days.map(() => 0);
  for (const r of rows) {
    const a = r.createdAt ? idx.get(dayKey(r.createdAt, timeZone)) : undefined;
    if (a !== undefined) added[a]!++;
    const c = r.completedAt ? idx.get(dayKey(r.completedAt, timeZone)) : undefined;
    if (c !== undefined) completed[c]!++;
  }
  return { days, added, completed };
}

/** SVG polyline points for a sparkline in a w×h box (shared max so two series compare). */
export function sparkPoints(values: number[], w: number, h: number, max = Math.max(1, ...values)): string {
  if (!values.length) return "";
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pad = 1;
  return values.map((v, i) => `${+(i * step).toFixed(1)},${+(h - pad - (Math.max(0, v) / max) * (h - pad * 2)).toFixed(1)}`).join(" ");
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
