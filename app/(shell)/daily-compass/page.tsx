import { requirePage } from "@/server/auth/page";
import { CompassView } from "./CompassView";

export const metadata = { title: "Daily Compass" };

export default async function CompassPage() {
  await requirePage("daily_compass.use");
  return <CompassView />;
}
