import { redirect } from "next/navigation";
import { getCurrentUser, isClaimed } from "@/server/auth";
import { config } from "@/server/config";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up Jarvis" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string; google?: string; message?: string }> }) {
  const claimed = isClaimed();
  const user = await getCurrentUser();
  if (claimed && !user) redirect("/login?next=/onboarding");
  const sp = await searchParams;
  return <OnboardingWizard claimed={claimed || config.authMode === "proxy"} initialStep={sp.step} googleStatus={sp.google} googleMessage={sp.message} />;
}
