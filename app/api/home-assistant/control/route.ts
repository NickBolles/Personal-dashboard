import { z } from "zod";
import { api } from "@/server/http/api";
import { executeControl } from "@/integrations/home-assistant/controls";
import { refreshSource } from "@/server/sources";
import { requireCap } from "@/server/access";
import { controlCap } from "@/lib/ha-policy";

const bodySchema = z.object({
  entityId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
  service: z.string().regex(/^[a-z_]+$/),
  stateToken: z.string().min(4).max(64),
  confirmed: z.literal(true),
  /** brightness_pct / temperature / hvac_mode / percentage / volume_level — validated per service by lib/ha-policy */
  data: z.record(z.string().max(40), z.union([z.string().max(40), z.number()])).optional(),
  /** high-risk actions (locks, alarm, opening a garage) need this explicit second confirm */
  highRiskConfirmed: z.boolean().optional(),
});

/** Run one allowlisted Home Assistant service for the signed-in person (confirmed, read back, never queued). */
export const POST = api<z.infer<typeof bodySchema>>(
  async ({ body, user, correlationId }) => {
    requireCap(user, controlCap(body.entityId));
    const res = await executeControl(body, user.id, correlationId, { role: user.role });
    await refreshSource("home_assistant").catch(() => undefined);
    return res;
  },
  { cap: ["home_assistant.control_doors", "home_assistant.control_lights"], body: bodySchema },
);
