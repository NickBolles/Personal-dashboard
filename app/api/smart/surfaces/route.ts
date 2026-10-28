import { z } from "zod";
import { api } from "@/server/http/api";
import { requireSmart, upsertSurface } from "@/server/smart/store";
import { LIMITS } from "@/lib/jarvis-ui/catalog";

const body = z
  .object({
    sessionId: z.string().min(1).max(200),
    blockIndex: z
      .number()
      .int()
      .min(0)
      .max(LIMITS.blocksPerMessage - 1),
    spec: z.unknown(),
  })
  .strict();

/** Store a smart surface on first render (validated server-side; idempotent per spec). */
export const PUT = api<z.infer<typeof body>>(
  ({ user, body }) => {
    requireSmart(user);
    return upsertSurface(user, body);
  },
  { body, cap: ["work.use", "todos.view"] },
);
