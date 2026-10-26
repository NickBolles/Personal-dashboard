import { api } from "@/server/http/api";
import { unfiledConversations } from "@/server/work/conversations";

export const dynamic = "force-dynamic";

/** Recent conversations not linked to any work item, with deterministic filing suggestions. */
export const GET = api(({ req, user }) => unfiledConversations(user, { revalidate: req.nextUrl.searchParams.get("refresh") === "1" }), { cap: "work.use" });
