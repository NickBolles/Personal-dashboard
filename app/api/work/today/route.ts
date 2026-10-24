import { api } from "@/server/http/api";
import { today } from "@/server/work/today";

export const dynamic = "force-dynamic";

/** Today: KPIs, things to continue, proof due, ready to settle, overdue (local data only). */
export const GET = api(({ user }) => today(user.id), { cap: "work.use" });
