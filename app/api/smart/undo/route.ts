import type { z } from "zod";
import { api } from "@/server/http/api";
import { undoIntent } from "@/server/smart/apply";
import { requireSmart } from "@/server/smart/store";
import { undoBodySchema } from "@/lib/jarvis-ui/intents";

/** Undo one applied change (reopen/re-snooze a todo, revert or archive a work item). */
export const POST = api<z.infer<typeof undoBodySchema>>(
  async ({ user, body, correlationId }) => {
    requireSmart(user);
    return undoIntent(user, body, correlationId);
  },
  { body: undoBodySchema, cap: ["work.use", "todos.edit"] },
);
