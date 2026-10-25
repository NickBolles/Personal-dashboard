import { requirePage } from "@/server/auth/page";
import { MapView } from "./MapView";

export const metadata = { title: "Work map" };

export default async function WorkMapPage({ searchParams }: { searchParams: Promise<{ root?: string }> }) {
  await requirePage("work.use");
  const { root } = await searchParams;
  return <MapView initialRoot={typeof root === "string" ? root : undefined} />;
}
