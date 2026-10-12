import { requirePage } from "@/server/auth/page";
import { WorkoutView } from "./WorkoutView";
export const metadata = { title: "Workouts" };
export default async function WorkoutsPage() {
  await requirePage("workouts.use");
  return <WorkoutView />;
}
