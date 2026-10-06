import { z } from "zod";
import { api } from "@/server/http/api";
import { setHolding } from "@/server/finance/funds";
import { cents } from "@/lib/finance/schemas";

const schema = z.object({ accountId: z.string().min(1).max(40), amount: cents.min(0), version: z.number().int().min(1).nullable() });
/** Earmark part of an account for this fund (an allocation, not a transfer). */
export const PUT = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    setHolding(params.id, body.accountId, body.amount, body.version, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
