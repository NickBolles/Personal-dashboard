import { z } from "zod";
import { api } from "@/server/http/api";
import { createFund, listFlows, listFunds, listHoldings } from "@/server/finance/funds";
import { financeSettings } from "@/server/finance/common";
import { listAccounts } from "@/server/finance/accounts";
import { currentResult } from "@/server/finance/checkins";

export const dynamic = "force-dynamic";

/** Funds, earmarks, the reserve schedule and settings (Finance → Funds & reserve). */
export const GET = api(
  () => {
    const res = currentResult();
    return {
      funds: listFunds(true),
      holdings: listHoldings(),
      flows: listFlows(),
      accounts: listAccounts(),
      settings: financeSettings(),
      summary: res?.result.funds ?? [],
      reserve: res?.result.reserve ?? null,
      accountSummaries: res?.result.accounts ?? [],
    };
  },
  { cap: "finance.view" },
);

const schema = z.object({ name: z.string().trim().min(1).max(60), protected: z.boolean().optional() });
export const POST = api<z.infer<typeof schema>>(({ body, user, correlationId }) => ({ id: createFund(body, user.id, correlationId) }), {
  cap: "finance.edit",
  body: schema,
});
