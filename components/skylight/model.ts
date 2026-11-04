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

export function choreWrite(action: NextAction, op: "chore.complete" | "chore.reopen"): SkylightWriteOp | null {
  const ref = action.skylight;
  if (ref?.kind !== "chore") return null;
  return { op, title: action.title, choreId: ref.choreId, instanceDate: ref.instanceDate, instanceTime: ref.instanceTime, categoryId: ref.categoryId };
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
