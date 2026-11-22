import { z } from "zod";
import { api } from "@/server/http/api";
import { ASSISTANT_BACKENDS } from "@/lib/assistant";
import { continueInConversation, ensureTaskChat } from "@/server/work/primary-chat";

const schema = z.object({ backend: z.enum(ASSISTANT_BACKENDS).optional(), handoff: z.boolean().optional() }).strict();

/**
 * The task's primary chat, created if it has none (filed under the task, on the profile that answers for its area).
 * The browser calls this when the first message is sent from the task page, then sends the message to the session.
 * `handoff`: that first message is the work packet's handoff, so the handoff is recorded on the task with it.
 */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  async ({ user, params, body, correlationId }) => {
    if (!body.handoff) return ensureTaskChat(user, params.id, body.backend, correlationId);
    const r = await continueInConversation(user, params.id, body.backend, correlationId);
    return { sessionId: r.session.id, created: r.created };
  },
  {
    capAll: ["work.use", "hermes.chat"],
    body: schema,
  },
);
