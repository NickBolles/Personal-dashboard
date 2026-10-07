import { requirePage } from "@/server/auth/page";
import { SkylightView } from "./SkylightView";

export const metadata = { title: "Skylight" };

export default async function SkylightPage() {
  await requirePage("skylight.view");
  return <SkylightView />;
}
