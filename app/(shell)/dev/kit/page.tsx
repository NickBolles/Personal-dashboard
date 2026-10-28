import { notFound } from "next/navigation";
import { getCurrentUser, getOwner } from "@/server/auth";
import { KitGallery } from "./KitGallery";

export const dynamic = "force-dynamic";
export const metadata = { title: "Component kit" };

/** Owner-only living style guide for the v1 component kit (docs/design-system.md §6). */
export default async function DevKitPage() {
  const user = await getCurrentUser();
  if (!user || user.id !== getOwner()?.id) notFound();
  return <KitGallery />;
}
