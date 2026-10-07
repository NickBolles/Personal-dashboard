import { api } from "@/server/http/api";
import { getCheckin } from "@/server/finance/checkins";
import { listAccounts } from "@/server/finance/accounts";
import { listFunds } from "@/server/finance/funds";
import { proposeMatches, recentTransactions } from "@/server/finance/sync";
import { financeSettings, today } from "@/server/finance/common";
import { addDays } from "@/lib/finance/engine";
import { upcomingPlanEvents } from "@/server/finance/plan";

export const dynamic = "force-dynamic";

/** Everything the check-in grid needs in one response. */
export const GET = api<undefined, { id: string }>(
  ({ params }) => {
    const c = getCheckin(params.id);
    const t = today();
    const draft = c.status === "draft";
    return {
      checkin: c,
      accounts: listAccounts(true),
      funds: listFunds(true),
      settings: financeSettings(),
      transactions: draft ? recentTransactions(addDays(t, -45)) : [],
      proposals: draft ? proposeMatches(params.id) : [],
      planEvents: draft ? upcomingPlanEvents(addDays(t, -60), addDays(t, 120)) : [],
    };
  },
  { cap: "finance.view" },
);
