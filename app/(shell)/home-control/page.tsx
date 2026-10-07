import { requirePage } from "@/server/auth/page";
import { HomeControlView } from "./HomeControlView";

export const metadata = { title: "Home" };

export default async function HomeControlPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  await requirePage("home_assistant.view", "home_assistant.calendar");
  const { entity } = await searchParams;
  return <HomeControlView focusEntity={entity} />;
}
