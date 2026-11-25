import { requirePage } from "@/server/auth/page";
import { BriefSettingsView } from "./BriefSettingsView";

export const metadata = { title: "Brief" };

export default async function BriefSettingsPage() {
  await requirePage("brief.use");
  return <BriefSettingsView />;
}
