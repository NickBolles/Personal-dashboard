import { z } from "zod";
import { api } from "@/server/http/api";
import { ASSISTANT_BACKENDS } from "@/lib/assistant";
import { ensureTaskChat } from "@/server/work/primary-chat";

const schema = z.object({ backend: z.enum(ASSISTANT_BACKENDS).optional() }).strict();

/**
 * The task's primary chat, created if it has none (filed under the task, on the profile that answers for its area).
 * The browser calls this when the first message is sent from the task page, then sends the message to the session.
 */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ user, params, body, correlationId }) => ensureTaskChat(user, params.id, body.backend, correlationId),
  {
    capAll: ["work.use", "hermes.chat"],
    body: schema,
  },
);
