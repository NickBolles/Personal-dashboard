import { z } from "zod";
import { api } from "@/server/http/api";
import { addActual } from "@/server/finance/plan";
import { cents, ymd } from "@/lib/finance/schemas";

const schema = z.object({
  date: ymd,
  amount: cents,
  allocations: z.array(z.object({ fundId: z.string().max(40).nullable(), amount: cents })).max(30),
  note: z.string().max(500).optional(),
  complete: z.boolean().optional(),
});
/** Record a confirmed installment with its stored fund effects. */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => ({ id: addActual(params.id, body, user.id, correlationId) }),
  {
    cap: "finance.edit",
    body: schema,
  },
);
