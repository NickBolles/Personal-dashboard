import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";

export type SkylightList = { id: string; label: string; kind: string };
export type SkylightExtra = {
  writable?: boolean;
  window?: { from: string; to: string };
  lists?: SkylightList[];
  listItems?: NextAction[];
  members?: { id: string; name: string }[];
  needsMember?: boolean;
  health?: { ok: boolean; failed: string[] };
};

export function choreWrite(action: NextAction, op: "chore.complete" | "chore.reopen" | "chore.skip"): SkylightWriteOp | null {
  const ref = action.skylight;
  if (ref?.kind !== "chore") return null;
  return {
    op,
    title: action.title,
    choreId: ref.choreId,
    instanceDate: ref.instanceDate,
    instanceTime: ref.instanceTime,
    categoryId: ref.categoryId,
    // Skylight's own flag only: a Family/group-assigned chore that Jarvis lists as up for grabs still 422s with category_id.
    ...(ref.upForGrabs ? { upForGrabs: true } : {}),
  };
}

/** Move a one-off chore to `day` (recurring occurrences can't be moved from Jarvis). */
export function rescheduleWrite(action: NextAction, day: string): SkylightWriteOp | null {
  const ref = action.skylight;
  if (ref?.kind !== "chore" || ref.recurring || !ref.startDate || ref.startDate === day) return null;
  return { op: "chore.reschedule", title: action.title, choreId: ref.choreId, start: day, previousStart: ref.startDate };
}

export function listWrite(action: NextAction): SkylightWriteOp | null {
  const ref = action.skylight;
  if (ref?.kind !== "list_item") return null;
  return {
    op: action.status === "completed" ? "list.uncheck" : "list.check",
    listId: ref.listId,
    itemId: ref.itemId,
    listLabel: ref.listLabel,
    label: action.title,
  };
}
