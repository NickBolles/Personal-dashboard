import { z } from "zod";
import { api } from "@/server/http/api";
import { switchLight } from "@/integrations/home-assistant/devices";
import { refreshSource } from "@/server/sources";

const schema = z.object({ entityId: z.string().regex(/^light\.[a-z0-9_]+$/), on: z.boolean() });

/** Switch a light. Reports success only after Home Assistant reads back the new state; never queued. */
export const POST = api<z.infer<typeof schema>>(
  async ({ body, user, correlationId }) => {
    const r = await switchLight(body.entityId, body.on, user.id, correlationId);
    await refreshSource("home_assistant").catch(() => undefined);
    return r;
  },
  { cap: "home_assistant.control_lights", body: schema },
);
