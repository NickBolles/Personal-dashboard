import { api } from "@/server/http/api";
import type { z } from "zod";
import { continueSchema } from "@/lib/work";
import { continueInConversation } from "@/server/work/primary-chat";

/** A task continues in its own chat (created if it has none); an area gets a new conversation. The browser pre-fills the handoff as an unsent draft. */
export const POST = api<z.infer<typeof continueSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => continueInConversation(user, params.id, body.backend, correlationId),
  { cap: "work.use", body: continueSchema },
);
