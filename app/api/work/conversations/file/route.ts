import { api } from "@/server/http/api";
import { fileConversationSchema } from "@/lib/work";
import { fileConversation } from "@/server/work/conversations";

/** One-click filing: link a conversation under an item, or in Miscellaneous (itemId null). */
export const POST = api(({ user, body, correlationId }) => fileConversation(user, body, correlationId), { cap: "work.use", body: fileConversationSchema });
