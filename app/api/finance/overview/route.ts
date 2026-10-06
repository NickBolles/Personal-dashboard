import { api } from "@/server/http/api";
import { financeOverview } from "@/server/finance/overview";

export const dynamic = "force-dynamic";

export const GET = api(() => financeOverview(), { cap: "finance.view" });
