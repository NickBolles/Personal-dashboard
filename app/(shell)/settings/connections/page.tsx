import { requirePage } from "@/server/auth/page";
import { ConnectionsView } from "./ConnectionsView";

export const metadata = { title: "Connections" };

export default async function ConnectionsPage() {
  await requirePage("admin");
  return <ConnectionsView />;
}
