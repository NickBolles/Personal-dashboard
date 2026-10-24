import { api } from "@/server/http/api";
import type { z } from "zod";
import { requireCap } from "@/server/access";
import { dismissConversationSchema } from "@/lib/work";
import { dismissConversation } from "@/server/work/inbox";

/** Hide an unfiled conversation from the Work inbox. Only its id is stored; Hermes keeps the conversation. */
export const POST = api<z.infer<typeof dismissConversationSchema>>(
  ({ user, body, correlationId }) => {
    requireCap(user, "hermes.chat");
    return dismissConversation(user, body.sessionId, correlationId);
  },
  { cap: "work.use", body: dismissConversationSchema },
);
