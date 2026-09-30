import { HomeControlView } from "./HomeControlView";

export const metadata = { title: "Home" };

export default async function HomeControlPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity } = await searchParams;
  return <HomeControlView focusEntity={entity} />;
}
