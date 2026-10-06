import { api } from "@/server/http/api";
import { adapterContext, refreshSource } from "@/server/sources";
import { completeCompass } from "@/integrations/daily-compass/adapter";

export const POST = api(
  async ({ user, correlationId }) => {
    const ctx = adapterContext();
    await completeCompass(ctx.today, user.id, correlationId);
    await refreshSource("daily_compass").catch(() => undefined);
    return { ok: true };
  },
  { cap: "daily_compass.use" },
);
