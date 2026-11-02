import { requirePage } from "@/server/auth/page";
import { listItems } from "@/server/work/store";
import { ActivityView } from "./ActivityView";

export const metadata = { title: "Activity" };

export default async function WorkActivityPage({ searchParams }: { searchParams: Promise<{ root?: string }> }) {
  const user = await requirePage("work.use");
  const { root } = await searchParams;
  const areas = listItems(user.id)
    .filter((i) => i.parentId === null && !i.archived)
    .map((i) => ({ id: i.id, title: i.title }));
  return <ActivityView areas={areas} initialArea={typeof root === "string" && areas.some((a) => a.id === root) ? root : ""} />;
}
