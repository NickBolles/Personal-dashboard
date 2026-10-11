import { requirePage } from "@/server/auth/page";
import { ConfigurationView } from "./ConfigurationView";

export const metadata = { title: "Configuration transfer" };

export default async function ConfigurationPage() {
  await requirePage("admin");
  return <ConfigurationView />;
}
