import { api } from "@/server/http/api";
import { can } from "@/server/access";
import { listDevices } from "@/integrations/home-assistant/devices";

export const dynamic = "force-dynamic";

/** Doors, locks, lights (home_assistant.view) and cameras (home_assistant.cameras), with the controls this person may use. */
export const GET = api(
  async ({ user }) =>
    listDevices({
      doors: can(user, "home_assistant.view"),
      lights: can(user, "home_assistant.view"),
      cameras: can(user, "home_assistant.cameras"),
      doorControls: can(user, "home_assistant.control_doors"),
      lightControls: can(user, "home_assistant.control_lights"),
    }),
  { cap: ["home_assistant.view", "home_assistant.cameras"] },
);
