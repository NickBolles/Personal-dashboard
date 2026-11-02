import { requirePage } from "@/server/auth/page";
import { listItems } from "@/server/work/store";
import { ActivityView } from "./ActivityView";

export const metadata = { title: "Activity" };

export default async function WorkActivityPage({ searchParams }: { searchParams: Promise<{ root?: string }> }) {
  const user = await requirePage("work.use");
  const { root } = await searchParams;
  const all = listItems(user.id);
  const areas = all.filter((i) => i.parentId === null && !i.archived).map((i) => ({ id: i.id, title: i.title }));
  // #131: a project's view switch opens Activity with ?root=<project>: offer it as a scope too.
  const rootItem = typeof root === "string" ? all.find((i) => i.id === root && !i.archived) : undefined;
  if (rootItem && !areas.some((a) => a.id === rootItem.id)) areas.unshift({ id: rootItem.id, title: rootItem.title });
  return <ActivityView areas={areas} initialArea={typeof root === "string" && areas.some((a) => a.id === root) ? root : ""} />;
}
