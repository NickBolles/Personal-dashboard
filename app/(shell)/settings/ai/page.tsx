import { requirePage } from "@/server/auth/page";
import { AiSettingsView } from "@/components/work/ai/AiSettingsView";
import "@/components/work/work.css";

export const metadata = { title: "AI" };

export default async function AiSettingsPage() {
  await requirePage("admin");
  return <AiSettingsView />;
}
