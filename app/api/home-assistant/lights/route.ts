import { z } from "zod";
import { api } from "@/server/http/api";
import { switchLight } from "@/integrations/home-assistant/devices";
import { refreshSource } from "@/server/sources";

const schema = z.object({
  entityId: z.string().regex(/^light\.[a-z0-9_]+$/),
  on: z.boolean(),
  /** optional: the token of the state the person saw (newer clients); else checked against a fresh read */
  stateToken: z.string().min(4).max(64).optional(),
});

/**
 * Switch a light (Android + older clients). Same gate as /api/home-assistant/control:
 * allowlist + Light switching setting, person-only, role, freshness, rate limit,
 * audit, and success only after Home Assistant reads back the new state. Never queued.
 */
export const POST = api<z.infer<typeof schema>>(
  async ({ body, user, correlationId }) => {
    const r = await switchLight(body.entityId, body.on, user.id, correlationId, { role: user.role, stateToken: body.stateToken });
    await refreshSource("home_assistant").catch(() => undefined);
    return r;
  },
  { cap: "home_assistant.control_lights", body: schema },
);
