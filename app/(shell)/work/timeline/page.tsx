import { requirePage } from "@/server/auth/page";
import { TimelineView } from "./TimelineView";

export const metadata = { title: "Work timeline" };

export default async function WorkTimelinePage({ searchParams }: { searchParams: Promise<{ root?: string }> }) {
  await requirePage("work.use");
  const { root } = await searchParams;
  return <TimelineView initialRoot={typeof root === "string" ? root : undefined} />;
}
