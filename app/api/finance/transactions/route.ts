import { api } from "@/server/http/api";
import { recentTransactions } from "@/server/finance/sync";
import { addDays } from "@/lib/finance/engine";
import { today } from "@/server/finance/common";

export const dynamic = "force-dynamic";

export const GET = api(
  ({ req }) => {
    const since = req.nextUrl.searchParams.get("since");
    return { transactions: recentTransactions(since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : addDays(today(), -45)) };
  },
  { cap: "finance.view" },
);
