import { api } from "@/server/http/api";
import type { z } from "zod";
import { forkSchema } from "@/lib/work";
import { forkItem, type OpOut } from "@/server/work/store";

export const POST = api<z.infer<typeof forkSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const out: OpOut = {};
    return { item: forkItem(user, params.id, body.title, correlationId, out), op: out.op ?? null };
  },
  {
    cap: "work.use",
    body: forkSchema,
  },
);
