import { api } from "@/server/http/api";
import { mapData } from "@/server/work/decisions";

/** /map: items + links + the "Needs you" list in one read. `?archived=1` keeps archived branches (Show archived, #183). */
export const GET = api(({ user, req }) => mapData(user, { includeArchived: req.nextUrl.searchParams.get("archived") === "1" }), { cap: "work.use" });
