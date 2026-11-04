import { z } from "zod";
import { api } from "@/server/http/api";
import { adoptSession } from "@/integrations/hermes/service";
import { getAgentSettings } from "@/server/agents/routing";
import { HttpError } from "@/server/http/errors";
import { noteIndexedSession } from "@/server/work/conversation-index";

const bodySchema = z.object({ profile: z.string().max(64).nullable(), sessionId: z.string().min(1).max(256) });

/** Start tracking an existing Hermes session (on its profile) so it can be filed and opened in Jarvis. */
export const POST = api<z.infer<typeof bodySchema>>(
  async ({ body, user, correlationId }) => {
    const profile = body.profile?.trim().toLowerCase() || null;
    if (profile && profile !== "default" && !getAgentSettings().routes.some((r) => r.profile === profile))
      throw new HttpError(400, "unknown_profile", "That agent isn't set up in Settings → Agents");
    const res = await adoptSession(user, { profile: profile === "default" ? null : profile, sessionId: body.sessionId }, correlationId);
    // Put the adopted chat into the cached conversation index (as createSession does) so lists and search show it now.
    try {
      noteIndexedSession(user.id, res.session);
    } catch {
      // The index is a cache; the next refresh corrects it.
    }
    return res;
  },
  { cap: ["hermes.chat"], body: bodySchema },
);
