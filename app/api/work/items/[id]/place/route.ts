import { api } from "@/server/http/api";
import type { z } from "zod";
import { placeSchema } from "@/lib/work";
import { placeItem, type OpOut } from "@/server/work/store";

/** Drag-and-drop placement: reorder among siblings and/or re-parent (cycle-safe, records moved_from). */
export const POST = api<z.infer<typeof placeSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    return { item: placeItem(user, params.id, body, correlationId, out), op: out.op ?? null };
  },
  { cap: "work.use", body: placeSchema },
);
