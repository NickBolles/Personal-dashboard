import type { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { agentSettingsPatchSchema } from "@/lib/agents";
import { agentRouteStatus, getAgentSettings, saveAgentSettings } from "@/server/agents/routing";
import { isConfigured } from "@/integrations/store";

export const dynamic = "force-dynamic";

/** Never includes a key: only the env var name and whether it is set on the server. */
const view = () => ({ settings: getAgentSettings(), routes: agentRouteStatus(), hermesConfigured: isConfigured("hermes") });

/** Settings → Agents (admin): per-profile Hermes routing and the AG-UI stream flag. */
export const GET = api(() => view(), { cap: "admin" });

export const PUT = api<z.infer<typeof agentSettingsPatchSchema>>(
  ({ user, body, correlationId }) => {
    const next = saveAgentSettings(body);
    audit({
      actor: user.id,
      action: "agents.settings",
      source: "agents",
      result: "ok",
      correlationId,
      detail: { routing: next.routing, aguiStream: next.aguiStream, profiles: next.routes.map((r) => r.profile) },
    });
    return view();
  },
  { cap: "admin", body: agentSettingsPatchSchema },
);
