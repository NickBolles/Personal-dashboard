import { api } from "@/server/http/api";
import type { z } from "zod";
import { updateItemSchema } from "@/lib/work";
import { getDetail, updateItem, type OpOut } from "@/server/work/store";

type P = { id: string };
export const GET = api<undefined, P>(({ user, params }) => getDetail(user.id, params.id), { cap: "work.use" });
/** Edits; archiving/unarchiving also returns an undoable `op`. */
export const PATCH = api<z.infer<typeof updateItemSchema>, P>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    return { item: updateItem(user, params.id, body, correlationId, out), op: out.op ?? null };
  },
  {
    cap: "work.use",
    body: updateItemSchema,
  },
);
