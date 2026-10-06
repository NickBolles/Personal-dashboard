import { z } from "zod";
import { api } from "@/server/http/api";
import { acknowledge } from "@/server/finance/checkins";

const schema = z.object({ key: z.string().min(1).max(200), note: z.string().max(500).optional() });
/** Acknowledge a warning (blocking issues can't be acknowledged). */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    acknowledge(params.id, body.key, body.note, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
