import { redirect } from "next/navigation";
import { getCurrentUser, isClaimed } from "@/server/auth";
import { getPreferences } from "@/server/settings";
import { visibleModules } from "@/server/access";
import { AppShell } from "@/components/navigation/AppShell";
import { AccessProvider } from "@/components/access";

export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect(isClaimed() ? "/login" : "/onboarding");
  // Setup is the admin's job; everyone else goes straight in.
  if (!getPreferences().onboarding.completedAt && user.capabilities.has("admin")) redirect("/onboarding");
  const prefs = getPreferences(user.id);
  const access = { role: user.role, capabilities: [...user.capabilities].sort(), modules: visibleModules(user).map((m) => m.id) };
  return (
    <AccessProvider value={access}>
      <AppShell userName={prefs.displayName || user.name}>{children}</AppShell>
    </AccessProvider>
  );
}
