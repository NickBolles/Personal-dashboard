import { api } from "@/server/http/api";
import { unfiledConversations } from "@/server/work/conversations";

export const dynamic = "force-dynamic";

/** Recent conversations not linked to any work item, with deterministic filing suggestions. */
export const GET = api(({ user }) => unfiledConversations(user), { cap: "work.use" });
