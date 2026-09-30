import { PRIORITY_ORDER, type NextAction, type PriorityReason } from "@/lib/contracts";
import { HOUR } from "@/lib/time";

/**
 * Deterministic, inspectable ranking for Home. No opaque scores.
 *
 * Order: critical → awaiting_user → overdue → due_soon (≤4h) → checkin_window
 *        → today → upcoming
 * Tie-breakers: user-pinned, due timestamp (earliest first, undated last),
 *               most recently changed, stable ID.
 */

export const DUE_SOON_MS = 4 * HOUR;

export type ClassifyInput = {
  dueAt?: string;
  /** end of the user's local day (exclusive) as an instant */
  endOfToday: Date;
  now: Date;
};

/** Classify a dated item into overdue / due_soon / today / upcoming. */
export function classifyDue({ dueAt, endOfToday, now }: ClassifyInput): PriorityReason {
  if (!dueAt) return "upcoming";
  const due = new Date(dueAt).getTime();
  const t = now.getTime();
  if (due < t) return "overdue";
  if (due - t <= DUE_SOON_MS) return "due_soon";
  if (due < endOfToday.getTime()) return "today";
  return "upcoming";
}

const rankOf = (r: PriorityReason) => PRIORITY_ORDER.indexOf(r);

export function compareActions(a: NextAction, b: NextAction): number {
  const r = rankOf(a.priorityReason) - rankOf(b.priorityReason);
  if (r !== 0) return r;
  const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pin !== 0) return pin;
  const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad < bd ? -1 : 1;
  const au = new Date(a.updatedAt).getTime();
  const bu = new Date(b.updatedAt).getTime();
  if (au !== bu) return bu - au;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankActions(actions: NextAction[]): NextAction[] {
  return [...actions].sort(compareActions);
}

/**
 * Deduplicate only on a durable cross-reference (same source + sourceId, or an
 * explicit alias id). Similar titles are never merged.
 */
export function dedupeActions(actions: NextAction[], aliases: Map<string, string> = new Map()): NextAction[] {
  const seen = new Map<string, NextAction>();
  for (const a of actions) {
    const key = aliases.get(a.id) ?? `${a.source}:${a.sourceId}`;
    const prev = seen.get(key);
    if (!prev || compareActions(a, prev) < 0) seen.set(key, a);
  }
  return [...seen.values()];
}

export type Partitioned = {
  now: NextAction[];
  laterToday: NextAction[];
  upcoming: NextAction[];
  waitingOn: NextAction[];
  recentlyCompleted: NextAction[];
};

export const NOW_LIMIT = 3;

/** Split ranked actions into the Home sections. */
export function partitionForHome(actions: NextAction[], now: Date, limit = NOW_LIMIT): Partitioned {
  const open = rankActions(actions.filter((a) => a.status === "open" && (!a.availableAt || new Date(a.availableAt) <= now)));
  const deferred = actions.filter((a) => a.status === "open" && a.availableAt && new Date(a.availableAt) > now);
  const nowItems = open.slice(0, limit);
  const rest = open.slice(limit);
  return {
    now: nowItems,
    laterToday: rest.filter((a) => a.priorityReason !== "upcoming"),
    upcoming: rankActions([...rest.filter((a) => a.priorityReason === "upcoming"), ...deferred]),
    waitingOn: rankActions(actions.filter((a) => a.status === "waiting")),
    recentlyCompleted: actions
      .filter((a) => a.status === "completed")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5),
  };
}
