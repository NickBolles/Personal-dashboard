import { requirePage } from "@/server/auth/page";
import { ActivityView } from "./ActivityView";

export const metadata = { title: "Activity log" };

export default async function ActivityPage() {
  await requirePage("admin");
  return <ActivityView />;
}
