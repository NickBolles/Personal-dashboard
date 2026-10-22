import { api } from "@/server/http/api";
import { timeline } from "@/server/work/store";

export const GET = api(({ req, user }) => timeline(user.id, req.nextUrl.searchParams.get("root") || null), { cap: "work.use" });
