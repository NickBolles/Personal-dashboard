import { api } from "@/server/http/api";
import type { z } from "zod";
import { settleSchema } from "@/lib/work";
import { settleItem } from "@/server/work/store";

/** Allowed only when every validation is pass or waived (server/work/lifecycle.ts). */
export const POST = api<z.infer<typeof settleSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ item: settleItem(user, params.id, body.reason, correlationId) }),
  {
    cap: "work.use",
    body: settleSchema,
  },
);
