import { z } from "zod";
import { api } from "@/server/http/api";
import { deleteFlow, updateFlow } from "@/server/finance/funds";
import { cents, version, ymd } from "@/lib/finance/schemas";

const schema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  accountId: z.string().min(1).max(40).optional(),
  amount: cents.optional(),
  date: ymd.optional(),
  recurrence: z.enum(["none", "weekly", "biweekly", "monthly", "yearly"]).optional(),
  reliable: z.boolean().optional(),
  fundId: z.string().max(40).nullable().optional(),
  active: z.boolean().optional(),
  version,
});

export const PATCH = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    updateFlow(params.id, body, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);

export const DELETE = api<undefined, { id: string }>(
  ({ params, user, correlationId }) => {
    deleteFlow(params.id, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit" },
);
