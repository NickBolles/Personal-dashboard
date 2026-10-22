import { api } from "@/server/http/api";
import { getDashboard } from "@/server/work/dashboard";

export const GET = api(({ user }) => getDashboard(user.id), { cap: "work.use" });
