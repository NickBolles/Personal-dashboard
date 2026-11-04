import { z } from "zod";
import { api } from "@/server/http/api";
import { reorder } from "@/server/quick-actions";
export const POST = api(({ user, body }) => reorder(user.id, body.ids), {
  cap: "work.use",
  body: z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(500) }).strict(),
});
