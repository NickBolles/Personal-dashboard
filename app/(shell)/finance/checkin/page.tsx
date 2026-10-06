import { redirect } from "next/navigation";
import { currentCheckin } from "@/server/finance/checkins";
import { CheckinList } from "./CheckinList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check-ins" };

/** Opens the current check-in, or lists them with a way to start this month's. */
export default async function CheckinIndex({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { all } = await searchParams;
  const current = currentCheckin();
  if (current && !all) redirect(`/finance/checkin/${current.id}`);
  return <CheckinList />;
}
