import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { adoptableSessions } from "@/integrations/hermes/service";
import { getAgentSettings, requestedAgentFor } from "@/server/agents/routing";
import { PROFILE_NAME_RE } from "@/lib/agents";

export const dynamic = "force-dynamic";

/**
 * Sessions on one Hermes profile that Jarvis doesn't track yet (Adopt existing chat).
 * `?profile=` picks the agent; without it, `?itemId=` defaults to that area's agent mode.
 * Also returns the profiles that have a route, so the picker never offers an unreachable one.
 */
export const GET = api(
  async ({ req, user }) => {
    const q = req.nextUrl.searchParams;
    const routes = getAgentSettings().routes.map((r) => r.profile);
    let profile = q.get("profile")?.trim().toLowerCase() || null;
    const itemId = q.get("itemId");
    if (!q.has("profile") && itemId) {
      const mode = requestedAgentFor(user.id, itemId).agentMode?.trim().toLowerCase() || null;
      profile = mode && routes.includes(mode) ? mode : null;
    }
    if (profile === "default") profile = null;
    if (profile && (!PROFILE_NAME_RE.test(profile) || !routes.includes(profile)))
      throw new HttpError(400, "unknown_profile", "That agent isn't set up in Settings → Agents");
    const res = await adoptableSessions(user, profile, req.signal);
    return { ...res, profiles: routes };
  },
  { cap: "hermes.chat" },
);
