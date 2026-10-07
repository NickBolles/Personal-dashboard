import { api } from "@/server/http/api";
import { listControls } from "@/integrations/home-assistant/controls";
import { can } from "@/server/access";

export const dynamic = "force-dynamic";

/** Live state for allowlisted controls. Never cached: controls require current state. */
export const GET = api(
  async ({ user }) => ({
    controls: (await listControls()).filter((c) => can(user, c.domain === "light" ? "home_assistant.control_lights" : "home_assistant.control_doors")),
    fetchedAt: new Date().toISOString(),
  }),
  {
    cap: ["home_assistant.control_doors", "home_assistant.control_lights"],
  },
);
