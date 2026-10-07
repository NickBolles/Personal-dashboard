import { api } from "@/server/http/api";
import { config } from "@/server/config";
import { getPreferences } from "@/server/settings";
import { getUser } from "@/server/auth";
import { visibleModules } from "@/server/access";
import type { Me } from "@/lib/people";

/** Who is signed in and what they can use (the phone builds its navigation from this). */
export const GET = api(({ user }): Me => {
  const prefs = getPreferences(user.id);
  return {
    user: { id: user.id, name: prefs.displayName || user.name, username: getUser(user.id)?.username ?? undefined, role: user.role, via: user.via },
    capabilities: [...user.capabilities].sort(),
    modules: visibleModules(user).map((m) => m.id),
    authMode: config.authMode,
    onboarded: Boolean(getPreferences().onboarding.completedAt),
  };
});
