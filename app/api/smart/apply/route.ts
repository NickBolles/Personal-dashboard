import type { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { applyIntents } from "@/server/smart/apply";
import { rateLimit } from "@/server/smart/rate";
import { requireSmart } from "@/server/smart/store";
import { applyBodySchema } from "@/lib/jarvis-ui/intents";

/**
 * Apply staged changes from a smart surface (one tap). Every intent is checked
 * against the stored spec, capability, ownership and the Finance rule before
 * anything is written; writes read back; results are per intent.
 */
export const POST = api<z.infer<typeof applyBodySchema>>(
  async ({ user, body, correlationId }) => {
    requireSmart(user);
    if (!rateLimit(`apply:${user.id}`, 120)) throw new HttpError(429, "rate_limited", "Too many changes this hour; try again later");
    return applyIntents(user, body, correlationId);
  },
  { body: applyBodySchema, cap: ["work.use", "todos.edit"] },
);
