import { z } from "zod";
import { api } from "@/server/http/api";
import { executeControl } from "@/integrations/home-assistant/controls";
import { refreshSource } from "@/server/sources";
import { requireCap } from "@/server/access";

const bodySchema = z.object({
  entityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
  service: z.string().regex(/^[a-z_]+$/),
  stateToken: z.string().min(4).max(64),
  confirmed: z.literal(true),
});

export const POST = api<z.infer<typeof bodySchema>>(
  async ({ body, user, correlationId }) => {
    requireCap(user, body.entityId.startsWith("light.") ? "home_assistant.control_lights" : "home_assistant.control_doors");
    const res = await executeControl(body, user.id, correlationId);
    await refreshSource("home_assistant").catch(() => undefined);
    return res;
  },
  { cap: ["home_assistant.control_doors", "home_assistant.control_lights"], body: bodySchema },
);
