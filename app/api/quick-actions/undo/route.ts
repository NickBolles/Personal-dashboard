import { z } from "zod";
import { api } from "@/server/http/api";
import { undo } from "@/server/quick-actions";
export const POST = api(({ user, body }) => undo(user, body.opId), { cap: "work.use", body: z.object({ opId: z.string().min(1).max(100) }).strict() });
