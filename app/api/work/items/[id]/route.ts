import { api } from "@/server/http/api";
import type { z } from "zod";
import { updateItemSchema } from "@/lib/work";
import { getDetail, updateItem } from "@/server/work/store";

type P = { id: string };
export const GET = api<undefined, P>(({ user, params }) => getDetail(user.id, params.id), { cap: "work.use" });
export const PATCH = api<z.infer<typeof updateItemSchema>, P>(
  ({ user, params, body, correlationId }) => ({ item: updateItem(user, params.id, body, correlationId) }),
  {
    cap: "work.use",
    body: updateItemSchema,
  },
);
