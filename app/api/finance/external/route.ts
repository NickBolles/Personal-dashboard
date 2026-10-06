import { z } from "zod";
import { api } from "@/server/http/api";
import { listExternalAccounts, setExternalIgnored } from "@/server/finance/accounts";

export const dynamic = "force-dynamic";

/** Provider account records seen in refreshes, for mapping (and marking duplicates). */
export const GET = api(() => ({ external: listExternalAccounts() }), { cap: "finance.view" });

const schema = z.object({ source: z.literal("monarch"), externalId: z.string().min(1).max(100), ignored: z.boolean() });
export const PATCH = api<z.infer<typeof schema>>(
  ({ body, user, correlationId }) => {
    setExternalIgnored(body.source, body.externalId, body.ignored, user.id, correlationId);
    return { external: listExternalAccounts() };
  },
  { cap: "finance.edit", body: schema },
);
