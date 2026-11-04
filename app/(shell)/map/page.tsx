import { redirect } from "next/navigation";
import { requirePage } from "@/server/auth/page";

export const metadata = { title: "Areas" };

/**
 * "Map is Areas": the portfolio overview lives on /areas now. Old bookmarks keep
 * working: /map → /areas (query kept), /map?area=<id> → that area.
 */
export default async function MapPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage("work.use");
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v !== "string") continue;
    if (k === "area") {
      if (!sp.item) q.set("item", v);
    } else q.set(k, v);
  }
  redirect(`/areas${q.size ? `?${q}` : ""}`);
}
