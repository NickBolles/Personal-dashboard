import { z } from "zod";
import { api } from "@/server/http/api";
import { forkConversation } from "@/server/areas";

const schema = z.object({
  title: z.string().max(200).optional(),
  fromMessageId: z.string().max(100).optional(),
  prompt: z.string().max(20000).optional(),
  idempotencyKey: z.string().max(255).optional(),
});

/** Fork; with Areas the fork lands next to its parent in the tree (forked_from lineage). */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ params, body, user, correlationId }) => forkConversation(user, params.id, body, correlationId),
  {
    body: schema,
    cap: "hermes.chat",
  },
);
