import { calendarDay, daysBetween, localDate, relativeTime } from "@/lib/time";
import type { NextAction } from "@/lib/contracts";

export function formatDue(
  a: Pick<NextAction, "dueAt" | "dueIsDate" | "dueTimezone">,
  now = Date.now(),
  timezone = a.dueTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  if (!a.dueAt) return undefined;
  const d = new Date(a.dueAt);
  if (a.dueIsDate) {
    const day = calendarDay(a.dueAt, timezone);
    const days = daysBetween(localDate(now, timezone), day);
    if (days === 0) return "Due today";
    if (days === -1) return "Due yesterday";
    if (days === 1) return "Due tomorrow";
    if (days < 0) return `Due ${-days} days ago`;
    return `Due ${new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}`;
  }
  return `Due ${relativeTime(d, now)}`;
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatWhen(iso: string, allDay?: boolean) {
  const d = allDay ? new Date(`${iso.slice(0, 10)}T12:00:00`) : new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = same(d, today) ? "Today" : same(d, tomorrow) ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return allDay ? `${day} · all day` : `${day} · ${formatTime(d.toISOString())}`;
}
