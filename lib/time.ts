/** Small, dependency-free time helpers shared by server and client. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function iso(d: Date | number = Date.now()) {
  return new Date(d).toISOString();
}

/** YYYY-MM-DD for the instant in the given IANA timezone. */
export function localDate(at: Date | number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Calendar day for a bare date or an instant in an explicit household timezone. */
export function calendarDay(value: string, timeZone: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDate(new Date(value), timeZone);
}

/** Calendar-date arithmetic on YYYY-MM-DD (no timezone or DST involved). */
export function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string) {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((ms(to) - ms(from)) / DAY);
}

/** Minutes since local midnight in the given timezone. */
export function localMinutes(at: Date | number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function parseHHMM(v: string) {
  const [h, m] = v.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `minutes` falls inside [start, end), handling windows that cross midnight. */
export function inWindow(minutes: number, start: string, end: string) {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** Offset (ms) of timeZone relative to UTC at the given instant. */
function tzOffset(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant for local midnight (start of day) of `date` (YYYY-MM-DD) in timeZone. */
export function startOfLocalDay(date: string, timeZone: string) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = new Date(Date.UTC(y!, m! - 1, d!));
  const offset = tzOffset(guess, timeZone);
  const result = new Date(guess.getTime() - offset);
  // Re-check across DST boundaries
  const offset2 = tzOffset(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2);
}

/**
 * UTC instant for HH:MM wall-clock time on `date` in timeZone. Resolved from
 * the offset in force at that wall time (not midnight's), so it stays right on
 * DST-change days (e.g. 17:30 on 2026-11-01 Chicago is 23:30Z, not 22:30Z);
 * a time inside a spring-forward gap moves forward (02:30 → 03:30).
 */
export function localTimeToInstant(date: string, hhmm: string, timeZone: string) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = new Date(Date.UTC(y!, m! - 1, d!) + parseHHMM(hhmm) * MINUTE);
  const offset = tzOffset(guess, timeZone);
  const result = new Date(guess.getTime() - offset);
  const offset2 = tzOffset(result, timeZone);
  if (offset2 === offset) return result;
  const second = new Date(guess.getTime() - offset2);
  if (tzOffset(second, timeZone) === offset2) return second;
  // Inside a spring-forward gap (e.g. 02:30): normalise forward, like the clock does.
  return result.getTime() > second.getTime() ? result : second;
}

export function relativeTime(target: string | number | Date, now = Date.now()) {
  const t = new Date(target).getTime();
  const diff = t - now;
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < MINUTE) return diff < 0 ? "just now" : "in a moment";
  if (abs < HOUR) return fmt.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return fmt.format(Math.round(diff / HOUR), "hour");
  return fmt.format(Math.round(diff / DAY), "day");
}
