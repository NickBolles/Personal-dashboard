import { requirePage } from "@/server/auth/page";
import { DashboardView } from "./DashboardView";

export const metadata = { title: "Work dashboard" };

export default async function WorkDashboardPage() {
  await requirePage("work.use");
  return <DashboardView />;
}
