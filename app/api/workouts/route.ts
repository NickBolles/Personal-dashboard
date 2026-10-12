import { api } from "@/server/http/api";
import { saveSchema } from "@/lib/workouts";
import { listWorkouts, saveWorkout } from "@/server/workouts";
export const GET = api(({ user }) => ({ workouts: listWorkouts(user.id) }), { cap: "workouts.use" });
export const POST = api(({ user, body }) => saveWorkout(user.id, body), { cap: "workouts.use", body: saveSchema });
