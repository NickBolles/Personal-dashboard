import { z } from "zod";
import { api } from "@/server/http/api";
import { updateEvent } from "@/server/finance/plan";
import { cents, version } from "@/lib/finance/schemas";

const schema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["open", "partial", "complete"]).optional(),
  remainingAmount: cents.nullable().optional(),
  /** a person reviewed an imported event */
  reconciled: z.boolean().optional(),
  version,
});
export const PATCH = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    updateEvent(params.id, body, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
