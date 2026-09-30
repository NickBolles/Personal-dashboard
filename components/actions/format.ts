import { relativeTime } from "@/lib/time";
import type { NextAction } from "@/lib/contracts";

export function formatDue(a: Pick<NextAction, "dueAt" | "dueIsDate">, now = Date.now()) {
  if (!a.dueAt) return undefined;
  const d = new Date(a.dueAt);
  if (a.dueIsDate) {
    const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86_400_000);
    if (days === 0) return "Due today";
    if (days === -1) return "Due yesterday";
    if (days === 1) return "Due tomorrow";
    if (days < 0) return `Due ${-days} days ago`;
    return `Due ${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
  }
  return `Due ${relativeTime(d, now)}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
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
