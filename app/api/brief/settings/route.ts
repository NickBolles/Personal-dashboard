import type { z } from "zod";
import { api } from "@/server/http/api";
import { briefSettingsPatch } from "@/lib/brief";
import { aiStatus, BRIEF_CAP } from "@/server/brief";
import { getBriefSettings, saveBriefSettings } from "@/server/brief/store";

export const dynamic = "force-dynamic";

export const GET = api(({ user }) => ({ settings: getBriefSettings(user.id), ai: aiStatus() }), { cap: BRIEF_CAP });

export const PUT = api<z.infer<typeof briefSettingsPatch>>(({ user, body }) => ({ settings: saveBriefSettings(user.id, body), ai: aiStatus() }), {
  body: briefSettingsPatch,
  cap: BRIEF_CAP,
});
