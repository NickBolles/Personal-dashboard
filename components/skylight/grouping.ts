import type { NextAction } from "@/lib/contracts";
import { calendarDay, localDate } from "@/lib/time";

/**
 * Skylight-style chore order: today's chores by time of day (Morning < 12:00 ≤ Afternoon < 17:00 ≤ Evening,
 * no time = Anytime), then later days, then everything from a PAST day under "Overdue" at the bottom.
 * Days and times are frame-local (`startDate`/`startTime`, America/Chicago by default), so neither the
 * browser timezone nor a UTC `dueAt` hour moves a chore between buckets. A chore due earlier today stays in
 * its time-of-day bucket (the server calls it "overdue" once its time passes; its label turns amber instead).
 */
export const CHORE_BUCKETS = [
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "evening", label: "Evening" },
  { key: "anytime", label: "Anytime" },
  { key: "later", label: "Next 7 days" },
  { key: "overdue", label: "Overdue" },
] as const;

export type ChoreBucket = (typeof CHORE_BUCKETS)[number]["key"];
export type ChoreGroup = (typeof CHORE_BUCKETS)[number] & { actions: NextAction[] };
/** `late` = due today and its time has passed (amber); `overdue` = due on a past day (red). */
export type DueState = "late" | "overdue" | undefined;

type Opts = { now: Date | number; timezone: string };

/**
 * Open Skylight chore: direct-mode chores carry a `chore` ref; Hermes-mode chores (`mapHermesAnswer`) carry no ref
 * at all and stay read-only (writes need the ref). List items (`list_item` ref) are not chores.
 */
export const isOpenChore = (a: NextAction) => a.status === "open" && a.source === "skylight" && (a.skylight === undefined || a.skylight.kind === "chore");

/** Frame-local due day (YYYY-MM-DD); undated chores count as today. */
export function choreDay(a: NextAction, { now, timezone }: Opts) {
  const ref = a.skylight?.kind === "chore" ? a.skylight : undefined;
  if (ref?.instanceDate) return ref.instanceDate;
  if (ref?.startDate) return ref.startDate;
  // Date-only dues are stored as 23:59 frame-local (after midnight UTC): read the day in the frame tz.
  if (a.dueAt && !Number.isNaN(Date.parse(a.dueAt))) return calendarDay(a.dueAt, a.dueTimezone ?? timezone);
  return localDate(now, timezone);
}

/** Frame-local time of day (HH:MM), or undefined for an Anytime chore. */
export function choreTime(a: NextAction, timezone: string) {
  const ref = a.skylight?.kind === "chore" ? a.skylight : undefined;
  const t = ref?.instanceTime ?? ref?.startTime;
  if (t && /^\d{2}:\d{2}/.test(t)) return t.slice(0, 5);
  if (!a.dueAt || a.dueIsDate || a.dueAt.length <= 10) return undefined;
  const at = new Date(a.dueAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export function choreBucket(a: NextAction, opts: Opts): ChoreBucket {
  const day = choreDay(a, opts);
  const today = localDate(opts.now, opts.timezone);
  if (day < today) return "overdue";
  if (day > today) return "later";
  const time = choreTime(a, opts.timezone);
  if (!time) return "anytime";
  const hour = Number(time.slice(0, 2));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

const dueMs = (a: NextAction) => {
  const t = a.dueAt ? Date.parse(a.dueAt) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** Open Skylight chores in display order; empty buckets are omitted. Input is never mutated. */
export function groupSkylightChores(actions: NextAction[], opts: Opts): ChoreGroup[] {
  const open = actions.filter(isOpenChore);
  const key = (a: NextAction) => `${choreDay(a, opts)} ${choreTime(a, opts.timezone) ?? "99:99"}`;
  return CHORE_BUCKETS.map((group) => ({
    ...group,
    actions: open
      .filter((a) => choreBucket(a, opts) === group.key)
      .sort((a, b) => {
        // Overdue: most recently due first (yesterday's before last week's); elsewhere earliest first.
        const k = group.key === "overdue" ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b));
        if (k) return k;
        const ad = dueMs(a) ?? Infinity;
        const bd = dueMs(b) ?? Infinity;
        if (ad !== bd) return ad < bd ? -1 : 1;
        return a.title.localeCompare(b.title);
      }),
  })).filter((g) => g.actions.length > 0);
}

/** Colour state for an open chore's "Due …" label. */
export function dueState(a: NextAction, opts: Opts): DueState {
  if (!isOpenChore(a)) return undefined;
  const bucket = choreBucket(a, opts);
  if (bucket === "overdue") return "overdue";
  if (bucket === "later" || bucket === "anytime") return undefined;
  const due = dueMs(a);
  const now = typeof opts.now === "number" ? opts.now : opts.now.getTime();
  return due !== undefined && due < now ? "late" : undefined;
}
