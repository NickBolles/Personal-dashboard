import type { NextAction } from "@/lib/contracts";

const BUCKETS = [
  { key: "morning", label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "evening", label: "Evening" },
  { key: "anytime", label: "Anytime" },
  { key: "overdue", label: "Overdue" },
] as const;

type ChoreGroup = (typeof BUCKETS)[number] & { actions: NextAction[] };

function startTime(action: NextAction) {
  return action.skylight?.kind === "chore" ? action.skylight.startTime : undefined;
}

function bucket(action: NextAction): ChoreGroup["key"] {
  if (action.priorityReason === "overdue") return "overdue";
  const time = startTime(action);
  if (!time) return "anytime";
  const hour = Number(time.slice(0, 2));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function dueInstant(action: NextAction) {
  const at = action.dueAt ? Date.parse(action.dueAt) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** startTime is already frame-local, including recurring BYHOUR occurrences.
 * Neither the browser timezone nor a UTC dueAt hour should change its bucket.
 * Overdue is authoritative server metadata, not a client-side date calculation.
 */
export function groupSkylightChores(actions: NextAction[], _opts: { now: Date; timezone: string }): ChoreGroup[] {
  const open = actions.filter((action) => action.status === "open" && action.skylight?.kind === "chore");
  return BUCKETS.map((group) => ({
    ...group,
    actions: open.filter((action) => bucket(action) === group.key).sort((a, b) => {
      const aDue = dueInstant(a);
      const bDue = dueInstant(b);
      if (group.key === "overdue") {
        // Unknown due dates sort last, and the freshest overdue chores come first.
        if (aDue !== bDue) return aDue === undefined ? 1 : bDue === undefined ? -1 : bDue - aDue;
      }
      const time = (startTime(a) ?? "").localeCompare(startTime(b) ?? "");
      if (time) return time;
      if (aDue !== bDue) return aDue === undefined ? 1 : bDue === undefined ? -1 : aDue - bDue;
      return a.title.localeCompare(b.title);
    }),
  })).filter((group) => group.actions.length > 0);
}

export function dueTone(action: NextAction, now: Date): "danger" | "warn" | undefined {
  if (action.status !== "open") return undefined;
  if (action.priorityReason === "overdue") return "danger";
  // Date-only / Anytime chores have no elapsed time to warn about.
  if (action.priorityReason === "today" && !action.dueIsDate && action.dueAt && action.dueAt.length > 10 && Date.parse(action.dueAt) < now.getTime()) {
    return "warn";
  }
  return undefined;
}
