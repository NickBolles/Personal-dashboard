import { api } from "@/server/http/api";
import { importSchema } from "@/lib/workouts";
import { importWorkouts } from "@/server/workouts";
export const POST = api(({ user, body }) => importWorkouts(user.id, body), { cap: "workouts.use", body: importSchema });
