import { redirect } from "next/navigation";
import { legacyMapHref } from "@/lib/areas-view";

/** The old org-chart dependency map is the Areas Graph tab now (radial, keeps the selection): keep bookmarks working. */
export default async function WorkMapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyMapHref(await searchParams));
}
