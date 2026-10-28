import { api } from "@/server/http/api";
import { unfiledConversations } from "@/server/work/conversations";

export const dynamic = "force-dynamic";

/** Recent conversations not linked to any work item (`?misc=1`: or only in Miscellaneous), with deterministic filing suggestions. */
export const GET = api(
  ({ req, user }) =>
    unfiledConversations(user, { revalidate: req.nextUrl.searchParams.get("refresh") === "1", includeMisc: req.nextUrl.searchParams.get("misc") === "1" }),
  { cap: "work.use" },
);
