import { z } from "zod";
import { api } from "@/server/http/api";
import { setOpening } from "@/server/finance/plan";
import { cents } from "@/lib/finance/schemas";

const schema = z.object({
  fundId: z.string().min(1).max(40),
  opening: cents,
  goal: cents.nullable().optional(),
  rolloverNote: z.string().max(200).nullable().optional(),
});
export const PUT = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    const { fundId, ...rest } = body;
    setOpening(params.id, fundId, rest, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
