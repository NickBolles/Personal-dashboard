import { api } from "@/server/http/api";
import type { z } from "zod";
import { splitSchema } from "@/lib/work";
import { splitItem } from "@/server/work/store";

export const POST = api<z.infer<typeof splitSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ item: splitItem(user, params.id, body, correlationId) }),
  {
    cap: "work.use",
    body: splitSchema,
  },
);
