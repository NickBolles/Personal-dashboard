import { api } from "@/server/http/api";
import { resumeHub } from "@/server/work/resume";

export const dynamic = "force-dynamic";

/** Resume hub ("In flight"): runs in flight + recent conversations + Unfiled count. `?refresh=1` revalidates the index in the background. */
export const GET = api(({ req, user }) => resumeHub(user, { revalidate: req.nextUrl.searchParams.get("refresh") === "1" }), { cap: "work.use" });
