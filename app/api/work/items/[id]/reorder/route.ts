import { api } from "@/server/http/api";
import type { z } from "zod";
import { reorderSchema } from "@/lib/work";
import { reorderItem, type OpOut } from "@/server/work/store";

export const POST = api<z.infer<typeof reorderSchema>, { id: string }>(
  ({ user, params, body }) => {
    const out: OpOut = {};
    return { items: reorderItem(user, params.id, body.direction, out), op: out.op ?? null };
  },
  {
    cap: "work.use",
    body: reorderSchema,
  },
);
