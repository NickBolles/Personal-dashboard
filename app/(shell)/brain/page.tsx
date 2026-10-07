import { requirePage } from "@/server/auth/page";
import { BrainView } from "./BrainView";

export const metadata = { title: "Brain" };

export default async function BrainPage() {
  await requirePage("hermes.brain");
  return <BrainView />;
}
