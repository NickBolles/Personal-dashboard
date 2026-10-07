import { z } from "zod";
import { api } from "@/server/http/api";
import { createEvent } from "@/server/finance/plan";
import { allocations, cents, ymd } from "@/lib/finance/schemas";

const schema = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(["income", "obligation", "reallocation"]),
  date: ymd,
  amount: cents,
  allocations,
});
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => ({ id: createEvent(params.id, body, user.id, correlationId) }),
  {
    cap: "finance.edit",
    body: schema,
  },
);
