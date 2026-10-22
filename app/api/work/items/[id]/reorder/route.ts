import { api } from "@/server/http/api";
import type { z } from "zod";
import { reorderSchema } from "@/lib/work";
import { reorderItem } from "@/server/work/store";

export const POST = api<z.infer<typeof reorderSchema>, { id: string }>(({ user, params, body }) => ({ items: reorderItem(user, params.id, body.direction) }), {
  cap: "work.use",
  body: reorderSchema,
});
