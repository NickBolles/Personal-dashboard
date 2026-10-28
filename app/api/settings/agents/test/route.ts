import { z } from "zod";
import { api } from "@/server/http/api";
import { audit } from "@/server/audit";
import { PROFILE_NAME_RE } from "@/lib/agents";
import { connForProfile } from "@/server/agents/routing";
import { HermesDiscoveryClient } from "@/integrations/hermes/client";

const schema = z.object({ profile: z.string().regex(PROFILE_NAME_RE) });

/**
 * Read-only probe of one profile route: unauthenticated /health (is the profile
 * served?) then /v1/capabilities with the profile's key (does the key work?).
 * Returns outcomes only, never the key or upstream bodies.
 */
export const POST = api<z.infer<typeof schema>>(
  async ({ body, user, correlationId }) => {
    let served = false;
    let authorized = false;
    let message = "ok";
    try {
      const conn = connForProfile(body.profile, "admin-connection-test");
      await HermesDiscoveryClient.health({ baseUrl: conn.baseUrl });
      served = true;
      await HermesDiscoveryClient.capabilities(conn);
      authorized = true;
    } catch (err) {
      message = (err as Error).message.slice(0, 200);
    }
    audit({
      actor: user.id,
      action: "agents.test",
      source: "agents",
      sourceRecord: body.profile,
      result: authorized ? "ok" : "error",
      correlationId,
      detail: { served, authorized },
    });
    return { profile: body.profile, served, authorized, message: authorized ? "Profile answers with its key" : message };
  },
  { cap: "admin", body: schema },
);
