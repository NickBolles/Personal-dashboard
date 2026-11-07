import { api } from "@/server/http/api";
import { dismissAway } from "@/server/agents/away";
export const dynamic = "force-dynamic";
export const POST = api(({ user, correlationId }) => dismissAway(user, new Date(), correlationId), { cap: "admin" });
