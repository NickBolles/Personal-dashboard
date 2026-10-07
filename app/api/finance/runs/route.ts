import { api } from "@/server/http/api";
import { runsList } from "@/server/finance/sync";

export const dynamic = "force-dynamic";

export const GET = api(() => ({ runs: runsList(20) }), { cap: "finance.view" });
