import type { z } from "zod";
import { api } from "@/server/http/api";
import { briefSettingsPatch } from "@/lib/brief";
import { aiStatus, BRIEF_CAP, cancelPendingBuilds } from "@/server/brief";
import { getBriefSettings, saveBriefSettings } from "@/server/brief/store";

export const dynamic = "force-dynamic";

export const GET = api(({ user }) => ({ settings: getBriefSettings(user.id), ai: aiStatus() }), { cap: BRIEF_CAP });

export const PUT = api<z.infer<typeof briefSettingsPatch>>(
  async ({ user, body, correlationId }) => {
    const settings = saveBriefSettings(user.id, body);
    // Off means off for builds already waiting too (the runner asks again as well, before it builds anything).
    if (body.ai === false) await cancelPendingBuilds(user.id, correlationId);
    return { settings, ai: aiStatus() };
  },
  { body: briefSettingsPatch, cap: BRIEF_CAP },
);
