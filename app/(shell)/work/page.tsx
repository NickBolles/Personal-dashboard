import { requirePage } from "@/server/auth/page";
import { WorkView } from "./WorkView";

export const metadata = { title: "Work" };

export default async function WorkPage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  await requirePage("work.use");
  const { item } = await searchParams;
  return <WorkView initialItem={typeof item === "string" ? item : undefined} />;
}
