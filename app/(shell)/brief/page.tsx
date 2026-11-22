import { requirePage } from "@/server/auth/page";
import { BriefView } from "@/components/brief/BriefView";

export const metadata = { title: "Brief" };

export default async function BriefPage() {
  await requirePage("brief.use");
  return <BriefView />;
}
