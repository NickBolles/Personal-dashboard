import { z } from "zod";
import { api } from "@/server/http/api";
import { setLeg } from "@/server/finance/checkins";

const schema = z.object({ side: z.enum(["source", "destination"]), inclusion: z.enum(["included", "excluded", "unknown"]), evidence: z.string().max(300) });
/** Is this leg already in the snapshot? A fact with evidence, separate from the action's status. */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    setLeg(params.id, body.side, body.inclusion, body.evidence, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
