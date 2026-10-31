import { api } from "@/server/http/api";
import { homePulse } from "@/server/home/pulse";

export const dynamic = "force-dynamic";

/** Today counts + 14-day trend for the Home KPI strip (each count gated by capability). */
export const GET = api(({ user }) => homePulse(user));
