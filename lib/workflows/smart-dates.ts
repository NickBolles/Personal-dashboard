/**
 * Smart date sources for workflow form defaults (spec §12.4), resolved
 * server-side in the owner's timezone, never by the model.
 */

export type SmartDateSource = "$today" | "$now" | "$tomorrow" | "$nextSunday" | "$serviceTime";
export const SMART_DATE_SOURCES: SmartDateSource[] = ["$today", "$now", "$tomorrow", "$nextSunday", "$serviceTime"];

type Wall = { date: string; time: string; weekday: number; minutes: number };

/** Wall-clock parts of `now` in `tz`. */
export function wallClock(now: Date, tz: string): Wall {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const time = `${parts.hour}:${parts.minute}`;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const hhmm = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Today if Sunday before 13:00, else the next Sunday. */
export function nextSunday(w: Wall): string {
  if (w.weekday === 0 && w.minutes < 13 * 60) return w.date;
  return addDays(w.date, (7 - w.weekday) % 7 || 7);
}

export type SmartDateValue = { date: string; time?: string; datetime?: string };

/**
 * Resolve a smart source. `$serviceTime` picks the current/next slot within
 * ±90 min today (Sunday only), else the first slot of `$nextSunday`.
 */
export function resolveSmartDate(source: SmartDateSource, opts: { now: Date; timezone: string; serviceTimes?: string[] }): SmartDateValue {
  const w = wallClock(opts.now, opts.timezone);
  const at = (date: string, time: string) => ({ date, time, datetime: `${date}T${time}` });
  switch (source) {
    case "$today":
      return { date: w.date };
    case "$now":
      return at(w.date, w.time);
    case "$tomorrow":
      return { date: addDays(w.date, 1) };
    case "$nextSunday":
      return { date: nextSunday(w) };
    case "$serviceTime": {
      const slots = [...(opts.serviceTimes?.length ? opts.serviceTimes : ["09:00", "10:45"])].sort();
      if (w.weekday === 0) {
        const dist = (s: string) => Math.abs(hhmm(s) - w.minutes);
        const near = [...slots].filter((s) => dist(s) <= 90).sort((x, y) => dist(x) - dist(y))[0] ?? slots.find((s) => hhmm(s) > w.minutes);
        if (near) return at(w.date, near);
      }
      const sunday = w.weekday === 0 ? addDays(w.date, 7) : nextSunday(w);
      return at(sunday, slots[0]);
    }
  }
}

/** Date words for palette args / quick chips: today, tomorrow, sunday, next sunday, 11/8, 2026-11-08. */
export function parseDateWord(input: string, opts: { now: Date; timezone: string }): string | null {
  const s = input.trim().toLowerCase();
  const w = wallClock(opts.now, opts.timezone);
  if (s === "today") return w.date;
  if (s === "tomorrow") return addDays(w.date, 1);
  if (s === "sunday" || s === "next sunday" || s === "sun") return nextSunday(w);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealDate(s) ? s : null;
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(w.date.slice(0, 4));
    const d = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return isRealDate(d) ? d : null;
  }
  return null;
}

function isRealDate(d: string) {
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
