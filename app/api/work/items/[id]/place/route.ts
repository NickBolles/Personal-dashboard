import { api } from "@/server/http/api";
import type { z } from "zod";
import { placeSchema } from "@/lib/work";
import { placeItem } from "@/server/work/store";

/** Drag-and-drop placement: reorder among siblings and/or re-parent (cycle-safe, records moved_from). */
export const POST = api<z.infer<typeof placeSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ item: placeItem(user, params.id, body, correlationId) }),
  { cap: "work.use", body: placeSchema },
);
