/**
 * "Suggest a time" (pure, spec §7.3): Jarvis computes free slots from the
 * person's calendars on the server. Calendar data never goes to AI; the model
 * only estimates duration/windows/deadline (schedule output).
 */
import type { ScheduleSlot } from "@/lib/ai";

export type Busy = { start: string; end?: string | null; allDay?: boolean };
export type ScheduleInput = {
  durationMinutes: number;
  splitOk?: boolean;
  preferredWindows?: ("morning" | "afternoon" | "evening" | "weekend" | "weekday")[];
  earliest?: string | null;
  deadline?: string | null;
  busy: Busy[];
  workHours: { start: string; end: string; days: number[] };
  quietHours?: { enabled: boolean; start: string; end: string };
  /** soft: days already targeted by in-progress items (YYYY-MM-DD) */
  loadedDays?: string[];
  tz: string;
  now: Date;
  horizonDays?: number;
};

const STEP = 30;
const BUFFER_MS = 15 * 60_000;
const DAY_START = 7 * 60;
const DAY_END = 21 * 60;

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function partsIn(at: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
  return { day: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")), weekday: wd };
}

/** Local wall time (day + minutes) in `tz` → UTC instant (DST-correct). */
export function zonedToUtc(day: string, minutes: number, tz: string) {
  const guess = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(t), tz);
    const shown = Date.parse(`${p.day}T00:00:00Z`) + p.minutes * 60_000;
    t += guess - shown;
  }
  return new Date(t);
}

function addDay(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function inQuiet(m: number, q?: ScheduleInput["quietHours"]) {
  if (!q?.enabled) return false;
  const s = mins(q.start);
  const e = mins(q.end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

function windowOf(m: number): "morning" | "afternoon" | "evening" {
  return m < 12 * 60 ? "morning" : m < 17 * 60 ? "afternoon" : "evening";
}

export function findSlots(input: ScheduleInput, count = 3): ScheduleSlot[] {
  const full = search(input, input.durationMinutes, count);
  if (full.length || !input.splitOk || input.durationMinutes < 60) return full;
  const half = Math.ceil(input.durationMinutes / 2 / 15) * 15;
  return search(input, half, count).map((s) => ({ ...s, why: `${s.why} · first of two ${half}-minute sessions` }));
}

function search(input: ScheduleInput, duration: number, count: number): ScheduleSlot[] {
  const { tz, now } = input;
  const horizon = input.horizonDays ?? 14;
  const today = partsIn(now, tz).day;
  const earliestDay = input.earliest && /^\d{4}-\d{2}-\d{2}/.test(input.earliest) ? input.earliest.slice(0, 10) : today;
  const deadlineDay = input.deadline && /^\d{4}-\d{2}-\d{2}/.test(input.deadline) ? input.deadline.slice(0, 10) : null;
  const notBefore = now.getTime() + 15 * 60_000;
  const busy = input.busy
    .filter((b) => !b.allDay)
    .map((b) => {
      const s = Date.parse(b.start);
      const e = b.end ? Date.parse(b.end) : s + 60 * 60_000;
      return [s - BUFFER_MS, e + BUFFER_MS] as const;
    })
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const allDay = new Set(input.busy.filter((b) => b.allDay).map((b) => b.start.slice(0, 10)));
  const loaded = new Set(input.loadedDays ?? []);
  const prefs = new Set(input.preferredWindows ?? []);
  const workS = mins(input.workHours.start);
  const workE = mins(input.workHours.end);
  const candidates: ScheduleSlot[] = [];
  for (let i = 0; i <= horizon; i++) {
    const day = addDay(today, i);
    if (day < earliestDay) continue;
    if (deadlineDay && day > deadlineDay) break;
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const workDay = input.workHours.days.includes(weekday);
    for (let m = DAY_START; m + duration <= DAY_END; m += STEP) {
      if (inQuiet(m, input.quietHours) || inQuiet(m + duration - 1, input.quietHours)) continue;
      const start = zonedToUtc(day, m, tz);
      const end = new Date(start.getTime() + duration * 60_000);
      if (start.getTime() < notBefore) continue;
      if (busy.some(([s, e]) => start.getTime() < e && end.getTime() > s)) continue;
      let score = 100 - i * 3;
      const why: string[] = [];
      const w = windowOf(m);
      const weekend = weekday === 0 || weekday === 6;
      if (prefs.has(w)) {
        score += 20;
        why.push(`${w} as suggested`);
      }
      if (prefs.has("weekend") && weekend) {
        score += 20;
        why.push("weekend");
      }
      if (prefs.has("weekday") && !weekend) {
        score += 10;
        why.push("weekday");
      }
      if (workDay && m >= workS && m + duration <= workE) {
        score += 5;
        if (!prefs.size) why.push("within work hours");
      }
      if (allDay.has(day)) {
        score -= 15;
        why.push("an all-day event that day");
      }
      if (loaded.has(day)) score -= 5;
      if (!why.length) why.push("free in your calendars");
      candidates.push({ start: start.toISOString(), end: end.toISOString(), score, why: why.join(" · ") });
    }
  }
  // Best per day first (spread the options), then the rest; ties → earliest.
  candidates.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
  const out: ScheduleSlot[] = [];
  const days = new Set<string>();
  for (const c of candidates) {
    const d = partsIn(new Date(c.start), tz).day;
    if (days.has(d)) continue;
    days.add(d);
    out.push(c);
    if (out.length === count) break;
  }
  for (const c of candidates) {
    if (out.length >= count) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, count).sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
}
