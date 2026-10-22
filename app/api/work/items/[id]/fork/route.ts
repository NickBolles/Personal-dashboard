import { api } from "@/server/http/api";
import type { z } from "zod";
import { forkSchema } from "@/lib/work";
import { forkItem } from "@/server/work/store";

export const POST = api<z.infer<typeof forkSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ item: forkItem(user, params.id, body.title, correlationId) }),
  {
    cap: "work.use",
    body: forkSchema,
  },
);
