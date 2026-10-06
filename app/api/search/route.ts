import { api } from "@/server/http/api";
import { search } from "@/server/search";

export const dynamic = "force-dynamic";

/** GET /api/search?q=soccer — across every module the caller can see. */
export const GET = api(({ req, user }) => search(user, req.nextUrl.searchParams.get("q") ?? ""));
