import { z } from "zod";
import { api } from "@/server/http/api";
import { createFlow } from "@/server/finance/funds";
import { cents, ymd } from "@/lib/finance/schemas";

const flowInput = z.object({
  label: z.string().trim().min(1).max(80),
  accountId: z.string().min(1).max(40),
  amount: cents,
  date: ymd,
  recurrence: z.enum(["none", "weekly", "biweekly", "monthly", "yearly"]).optional(),
  reliable: z.boolean().optional(),
  fundId: z.string().max(40).nullable().optional(),
});

export const POST = api<z.infer<typeof flowInput>>(({ body, user, correlationId }) => ({ id: createFlow(body, user.id, correlationId) }), {
  cap: "finance.edit",
  body: flowInput,
});
