import { z } from "zod";
import { api } from "@/server/http/api";
import { upsertEstimate } from "@/server/finance/plan";
import { allocations, cents, ymd } from "@/lib/finance/schemas";

const schema = z.object({ eventId: z.string().min(1).max(40), date: ymd, amount: cents, allocations, removed: z.boolean().optional() });
export const PUT = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    const { eventId, ...rest } = body;
    upsertEstimate(params.id, eventId, rest, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
