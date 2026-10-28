import { requirePage } from "@/server/auth/page";
import { AgentsSettingsView } from "@/components/agents/AgentsSettingsView";

export const metadata = { title: "Agents" };

export default async function AgentsSettingsPage() {
  await requirePage("admin");
  return <AgentsSettingsView />;
}
