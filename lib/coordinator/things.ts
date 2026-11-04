import type { ActivityItem } from "@/lib/activity";
import type { DecisionEntry } from "@/lib/decisions";

export type CoordinatorRun = { id: string; itemId: string; title: string; state: "running" | "stalled" | "failed" | "waiting"; at: string | null };
export type CoordinatorThings = {
  needsYou: number;
  decisions: DecisionEntry[];
  running: CoordinatorRun[];
  failing: CoordinatorRun[];
  doneUnseen: number;
  changes: ActivityItem[];
};
export type PriorityInput = Pick<CoordinatorThings, "needsYou" | "doneUnseen"> & { running: number; failing: number };
export type PriorityLine = {
  state: "failing" | "needs" | "running" | "done" | "idle";
  tone: "bad" | "warn" | "ai" | "ok" | "neutral";
  dot: "red" | "yellow" | null;
  text: string;
  count: number;
};
const ranks: Record<PriorityLine["state"], number> = { failing: 4, needs: 3, done: 2, running: 1, idle: 0 };
export function priorityLine(input: PriorityInput): PriorityLine {
  if (input.failing > 0)
    return {
      state: "failing",
      tone: "bad",
      dot: "red",
      text: `${input.failing} ${input.failing === 1 ? "run needs" : "runs need"} attention`,
      count: input.failing,
    };
  if (input.needsYou > 0)
    return {
      state: "needs",
      tone: "warn",
      dot: "yellow",
      text: `${input.needsYou} ${input.needsYou === 1 ? "thing needs" : "things need"} you`,
      count: input.needsYou,
    };
  if (input.doneUnseen > 0)
    return { state: "done", tone: "ok", dot: "yellow", text: `${input.doneUnseen} finished · ready to review`, count: input.doneUnseen };
  if (input.running > 0)
    return { state: "running", tone: "ai", dot: null, text: `${input.running} ${input.running === 1 ? "run" : "runs"} in progress`, count: input.running };
  return { state: "idle", tone: "neutral", dot: null, text: "All quiet · ask anything", count: 0 };
}

/** sinceMs is when the pending downward transition was first observed. */
export function stablePriority(prev: PriorityLine, next: PriorityLine, sinceMs: number, now: number): PriorityLine {
  return ranks[next.state] < ranks[prev.state] && now - sinceMs < 4000 ? prev : next;
}
