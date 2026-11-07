import { notFound } from "next/navigation";
import { getCurrentUser, getOwner } from "@/server/auth";
import { LibraryGallery } from "./LibraryGallery";
import "@/components/work/work.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "UI library" };

/**
 * Owner-only gallery of the canonical UI library (`@/components/ui`, docs/ui-library.md):
 * the pieces app code composes (pickers, icon buttons, fields, states). The full design-system
 * kit (tokens, rows, agent marks, both themes) stays at /dev/kit. Both are visual-tested.
 */
export default async function DevUiPage() {
  const user = await getCurrentUser();
  if (!user || user.id !== getOwner()?.id) notFound();
  return <LibraryGallery />;
}
