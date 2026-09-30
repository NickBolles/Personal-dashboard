import { redirect } from "next/navigation";
import { getCurrentUser, isClaimed } from "@/server/auth";
import { getPreferences } from "@/server/settings";
import { AppShell } from "@/components/navigation/AppShell";

export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect(isClaimed() ? "/login" : "/onboarding");
  const prefs = getPreferences();
  if (!prefs.onboarding.completedAt) redirect("/onboarding");
  return <AppShell userName={prefs.displayName || user.name}>{children}</AppShell>;
}
