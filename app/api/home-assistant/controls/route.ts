import { api } from "@/server/http/api";
import { listControls } from "@/integrations/home-assistant/controls";
import { can } from "@/server/access";
import { controlCap } from "@/lib/ha-policy";

export const dynamic = "force-dynamic";

/** Live state for allowlisted door/lock/garage/alarm controls. Never cached: controls require current state. */
export const GET = api(
  async ({ user }) => ({
    controls: (await listControls(user.role)).filter((c) => can(user, controlCap(c.entityId))),
    fetchedAt: new Date().toISOString(),
  }),
  {
    cap: ["home_assistant.control_doors", "home_assistant.control_lights"],
  },
);
