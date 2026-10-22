import { api } from "@/server/http/api";
import type { z } from "zod";
import { moveSchema } from "@/lib/work";
import { moveItem } from "@/server/work/store";

export const POST = api<z.infer<typeof moveSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ item: moveItem(user, params.id, body.parentId, correlationId) }),
  {
    cap: "work.use",
    body: moveSchema,
  },
);
