import { z } from "zod";
import { api } from "@/server/http/api";
import { listAccounts, mapAccount, updateAccount } from "@/server/finance/accounts";
import { accountInput, version } from "@/lib/finance/schemas";

const schema = accountInput.partial().extend({
  archived: z.boolean().optional(),
  version,
  /** map to a provider record, or null to unmap */
  external: z
    .object({ source: z.literal("monarch"), externalId: z.string().min(1).max(100) })
    .nullable()
    .optional(),
});

export const PATCH = api<z.infer<typeof schema>, { id: string }>(
  ({ body, params, user, correlationId }) => {
    const { external, ...rest } = body;
    if (external !== undefined) {
      mapAccount(params.id, external, body.version, user.id, correlationId);
      return listAccounts(true).find((a) => a.id === params.id);
    }
    return updateAccount(params.id, rest, user.id, correlationId);
  },
  { cap: "finance.edit", body: schema },
);
