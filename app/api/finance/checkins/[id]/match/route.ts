import { z } from "zod";
import { api } from "@/server/http/api";
import { confirmMatch } from "@/server/finance/sync";

const schema = z.object({
  transactionId: z.string().min(1).max(40),
  actionId: z.string().min(1).max(40),
  side: z.enum(["source", "destination"]),
  inclusion: z.enum(["included", "excluded", "unknown"]),
});
/** A person confirms which action leg a transaction is, and whether it's in the snapshot. */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ body, user, correlationId }) => {
    confirmMatch(body, user.id, correlationId);
    return { ok: true };
  },
  { cap: "finance.edit", body: schema },
);
