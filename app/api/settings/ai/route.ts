import { api } from "@/server/http/api";
import type { z } from "zod";
import { aiSettingsPatchSchema } from "@/lib/ai";
import { audit } from "@/server/audit";
import { getAiSettings, saveAiSettings } from "@/server/ai/settings";
import { aiRunnerStatus, startAiRunner, stopAiRunner } from "@/server/ai/runner";
import { dispatcherStatus } from "@/server/notifications/dispatcher";
import { spendToday } from "@/server/ai/budget";
import { isConfigured } from "@/integrations/store";

export const dynamic = "force-dynamic";

const view = () => ({
  settings: getAiSettings(),
  runner: aiRunnerStatus(),
  dispatcher: dispatcherStatus(),
  today: spendToday(),
  hermesConfigured: isConfigured("hermes"),
});

/** Settings → AI (admin): budget, caps, models, capture mode, schedule, Hermes capability flags. */
export const GET = api(() => view(), { cap: "admin" });

export const PUT = api<z.infer<typeof aiSettingsPatchSchema>>(
  ({ user, body, correlationId }) => {
    const next = saveAiSettings(body);
    audit({ actor: user.id, action: "ai.settings", source: "ai", result: "ok", correlationId, detail: { keys: Object.keys(body), enabled: next.enabled } });
    // Re-arm (or stop) the runner with the new settings; the runner never runs while AI is off.
    if (next.enabled) startAiRunner();
    else stopAiRunner();
    return view();
  },
  { cap: "admin", body: aiSettingsPatchSchema },
);
