import "@/components/work/work.css";
import { requirePage } from "@/server/auth/page";
import { TagsSettingsView } from "@/components/work/TagsSettingsView";

export const metadata = { title: "Tags" };

export default async function TagsSettingsPage() {
  await requirePage("work.use");
  return <TagsSettingsView />;
}
