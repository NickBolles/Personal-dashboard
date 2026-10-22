import { api } from "@/server/http/api";
import type { z } from "zod";
import { reopenSchema } from "@/lib/work";
import { reopenItem } from "@/server/work/store";

export const POST = api<z.infer<typeof reopenSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => reopenItem(user, params.id, body, correlationId),
  {
    cap: "work.use",
    body: reopenSchema,
  },
);
