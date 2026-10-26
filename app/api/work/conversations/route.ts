import { api } from "@/server/http/api";
import { conversationList, listConversations } from "@/server/work/conversations";

export const dynamic = "force-dynamic";

/**
 * Conversation picker: your Hermes and Claude conversations (via server/assistant). Needs hermes.chat too.
 * `?view=all|unfiled` is the Areas conversations view (placement, suggestions, unfiled count).
 */
export const GET = api(
  ({ req, user }) => {
    const view = req.nextUrl.searchParams.get("view");
    const q = req.nextUrl.searchParams.get("q");
    // ?refresh=1: answer from the index at once and revalidate it in the background (`updating` in the reply).
    const opts = { revalidate: req.nextUrl.searchParams.get("refresh") === "1" };
    return view === "all" || view === "unfiled" ? conversationList(user, view, q, opts) : listConversations(user, q, opts);
  },
  { cap: "work.use" },
);
