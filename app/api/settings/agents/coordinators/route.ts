import { api } from "@/server/http/api";
import { coordinatorSettings } from "@/server/agents/coordinators";

export const dynamic = "force-dynamic";
/** Read-only profile coverage, granted scopes and attributed AI job estimates. */
export const GET = api(({ user }) => coordinatorSettings(user.id), { cap: "admin" });
