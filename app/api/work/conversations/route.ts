import { api } from "@/server/http/api";
import { listConversations } from "@/server/work/conversations";

export const dynamic = "force-dynamic";

/** Conversation picker: your Hermes and Claude conversations (via server/assistant). Needs hermes.chat too. */
export const GET = api(({ req, user }) => listConversations(user, req.nextUrl.searchParams.get("q")), { cap: "work.use" });
