import { api } from "@/server/http/api";
import { adapterContext } from "@/server/sources";
import { compassState } from "@/integrations/daily-compass/adapter";
import { resolveIntegration } from "@/integrations/store";

export const dynamic = "force-dynamic";

export const GET = api(
  async () => {
    const cfg = resolveIntegration("daily_compass");
    return { enabled: cfg.enabled, mode: cfg.config.mode, reminderTime: cfg.config.reminderTime, state: await compassState(adapterContext()) };
  },
  { cap: "daily_compass.use" },
);
