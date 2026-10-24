import { api } from "@/server/http/api";
import type { z } from "zod";
import { splitSchema } from "@/lib/work";
import { splitItem, type OpOut } from "@/server/work/store";

export const POST = api<z.infer<typeof splitSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    return { item: splitItem(user, params.id, body, correlationId, out), op: out.op ?? null };
  },
  {
    cap: "work.use",
    body: splitSchema,
  },
);
