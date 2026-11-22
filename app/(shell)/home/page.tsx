import { requirePage } from "@/server/auth/page";
import { getBriefSettings } from "@/server/brief/store";
import { BriefView } from "@/components/brief/BriefView";
import { HomeView } from "./HomeView";

export const metadata = { title: "Home" };

/**
 * Home is the daily brief once the person has turned the AI brief on (owner,
 * 2026-11-21). Until then, and at `?view=list`, it is the ranked list. Both
 * read the same Home selection; the brief never replaces what the list can do.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await requirePage();
  const { view } = await searchParams;
  const brief = view !== "list" && user.capabilities.has("brief.use") && getBriefSettings(user.id).ai;
  return brief ? <BriefView home /> : <HomeView />;
}
