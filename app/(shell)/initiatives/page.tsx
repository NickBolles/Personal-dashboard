import { requirePage } from "@/server/auth/page";
import { InitiativesView } from "./InitiativesView";

export const metadata = { title: "Initiatives" };

export default async function InitiativesPage() {
  await requirePage("paperclip.view");
  return <InitiativesView />;
}
