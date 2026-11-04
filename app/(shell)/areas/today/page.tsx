import { requirePage } from "@/server/auth/page";
import { TodayWorkView } from "./TodayWorkView";

export const metadata = { title: "Work today" };

/** The work queue (continue, proof due, ready to settle, overdue) — /areas itself opens on the portfolio overview. */
export default async function WorkTodayPage() {
  await requirePage("work.use");
  return <TodayWorkView />;
}
