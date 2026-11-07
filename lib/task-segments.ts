import type { NextAction } from "./contracts";

export type TaskSegment = "all" | "mine" | "ai" | "waiting";
export const parseTaskSegment = (raw: string | null): TaskSegment => (raw === "mine" || raw === "ai" || raw === "waiting" ? raw : "all");
export function taskInSegment(a: NextAction, segment: TaskSegment): boolean {
  if (segment === "all") return true;
  if (segment === "ai") return a.provenance?.via.startsWith("agent:") === true;
  if (segment === "mine") return a.assignee?.kind === "mine" || (!a.assignee && a.source === "todos");
  return a.status === "waiting" || (a.status === "open" && (a.assignee?.kind === "up_for_grabs" || a.assignee?.kind === "other"));
}
