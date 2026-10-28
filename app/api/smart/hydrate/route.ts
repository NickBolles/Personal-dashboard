import { z } from "zod";
import { api } from "@/server/http/api";
import { hydrate, requireSmart, todayLocal } from "@/server/smart/store";
import { LIMITS } from "@/lib/jarvis-ui/catalog";

const body = z.object({ refs: z.array(z.string().max(320)).max(LIMITS.hydrateRefs) }).strict();

/** Live titles/dates/status for the refs a smart reply mentions; unknown, foreign and Finance refs come back unavailable. */
export const POST = api<z.infer<typeof body>>(
  async ({ user, body }) => {
    requireSmart(user);
    return { refs: await hydrate(user, body.refs), today: todayLocal() };
  },
  { body, cap: ["work.use", "todos.view"] },
);
