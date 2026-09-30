import { z } from "zod";
import { api } from "@/server/http/api";
import { startRun } from "@/integrations/hermes/service";
import { getPreferences } from "@/server/settings";
import { assertShareableContext } from "@/server/privacy";

const schema = z.object({
  input: z.string().min(1).max(50000),
  idempotencyKey: z.string().min(8).max(255),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  context: z.string().max(4000).optional(),
});

/** Start a turn. Model/provider are sent only when the user overrides defaults. */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  ({ params, body, user, correlationId }) => {
    assertShareableContext(body.context);
    const prefs = getPreferences().hermes;
    const input = body.context ? `${body.input}\n\n---\nContext from Jarvis:\n${body.context}` : body.input;
    return startRun(
      user,
      {
        sessionId: params.id,
        input,
        idempotencyKey: body.idempotencyKey,
        model: body.model || prefs.defaultModel || undefined,
        provider: body.provider || prefs.defaultProvider || undefined,
      },
      correlationId,
    );
  },
  { body: schema },
);
