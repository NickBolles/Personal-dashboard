import { api } from "@/server/http/api";
import { sharedConversations } from "@/server/areas";

export const dynamic = "force-dynamic";

/** Your conversations shared with the household (Settings → Assistant). */
export const GET = api(({ user }) => sharedConversations(user), { cap: "hermes.chat" });
