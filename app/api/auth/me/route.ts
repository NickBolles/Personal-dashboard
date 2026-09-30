import { api } from "@/server/http/api";
import { config } from "@/server/config";
import { getPreferences } from "@/server/settings";

export const GET = api(({ user }) => {
  const prefs = getPreferences();
  return { user: { id: user.id, name: prefs.displayName || user.name, via: user.via }, authMode: config.authMode, onboarded: Boolean(prefs.onboarding.completedAt) };
});
