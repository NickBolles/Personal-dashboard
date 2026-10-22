import { api } from "@/server/http/api";
import type { z } from "zod";
import { moveSchema } from "@/lib/work";
import { moveItem, type OpOut } from "@/server/work/store";

export const POST = api<z.infer<typeof moveSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    return { item: moveItem(user, params.id, body.parentId, correlationId, out), op: out.op ?? null };
  },
  {
    cap: "work.use",
    body: moveSchema,
  },
);
