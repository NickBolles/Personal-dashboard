import { z } from "zod";
import { api } from "@/server/http/api";
import { markReviewed } from "@/server/work/tasks";

const schema = z.object({ ids: z.array(z.string().trim().min(1).max(64)).min(1).max(50) }).strict();

/** Mark finished tasks reviewed (closes each; every close is undoable). The owner's confirmed tap, never automatic. */
export const POST = api<z.infer<typeof schema>>(({ user, body, correlationId }) => markReviewed(user, body.ids, correlationId), {
  cap: "work.use",
  body: schema,
});
