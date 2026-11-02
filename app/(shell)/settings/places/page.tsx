import "@/components/work/work.css";
import { requirePage } from "@/server/auth/page";
import { SavedPlacesSettings } from "@/components/workflows/SavedPlacesSettings";

export const metadata = { title: "Saved places" };

export default async function SavedPlacesPage() {
  await requirePage("work.use");
  return <SavedPlacesSettings />;
}
