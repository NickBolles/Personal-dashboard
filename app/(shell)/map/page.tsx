import { requirePage } from "@/server/auth/page";
import { WorkShell } from "@/components/work/common";
import { MapView } from "@/components/map/MapView";
import "@/components/work/work.css";
import "@/components/map/map.css";

export const metadata = { title: "Map" };

/** Work from Jarvis: the portfolio overview (area rollups → drill-down tree). */
export default async function MapPage() {
  await requirePage("work.use");
  return (
    <WorkShell>
      <MapView />
    </WorkShell>
  );
}
