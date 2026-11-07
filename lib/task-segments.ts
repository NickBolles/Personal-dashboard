import type { NextAction } from "./contracts";

// NextAction has no agent assignee or creator provenance: there is deliberately no AI segment.
export type TaskSegment = "all" | "mine" | "waiting";
export const parseTaskSegment = (raw: string | null): TaskSegment => (raw === "mine" || raw === "waiting" ? raw : "all");
export function taskInSegment(a: NextAction, segment: TaskSegment): boolean {
  if (segment === "all") return true;
  if (segment === "mine") return a.assignee?.kind === "mine" || (!a.assignee && a.source === "todos");
  return a.status === "waiting" || (a.status === "open" && (a.assignee?.kind === "up_for_grabs" || a.assignee?.kind === "other"));
}
