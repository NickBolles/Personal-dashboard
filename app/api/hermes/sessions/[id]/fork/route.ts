import { z } from "zod";
import { api } from "@/server/http/api";
import { forkSession } from "@/integrations/hermes/service";

const schema = z.object({
  title: z.string().max(200).optional(),
  fromMessageId: z.string().max(100).optional(),
  prompt: z.string().max(20000).optional(),
  idempotencyKey: z.string().max(255).optional(),
});

export const POST = api<z.infer<typeof schema>, { id: string }>(({ params, body, user, correlationId }) => forkSession(user, params.id, body, correlationId), {
  body: schema,
  cap: "hermes.chat",
});
