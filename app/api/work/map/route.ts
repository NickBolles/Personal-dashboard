import { api } from "@/server/http/api";
import { mapGraph } from "@/server/work/map";

/** Read-only map graph of an area/project (?root=) or of all your work. */
export const GET = api(({ req, user }) => mapGraph(user.id, req.nextUrl.searchParams.get("root") || null), { cap: "work.use" });
