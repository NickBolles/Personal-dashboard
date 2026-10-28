import { z } from "zod";
import { api } from "@/server/http/api";
import { requireSmart, saveState } from "@/server/smart/store";

const body = z.object({ state: z.object({ checks: z.array(z.string().max(300)).max(200).optional() }).strict() }).strict();

/** UI state of a surface (checklist ticks), ≤ 16 KB. Records only; never runs anything. */
export const PATCH = api<z.infer<typeof body>, { id: string }>(
  ({ user, body, params }) => {
    requireSmart(user);
    return saveState(user, params.id, body.state);
  },
  { body, cap: ["work.use", "todos.view"] },
);
