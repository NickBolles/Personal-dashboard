import { z } from "zod";
import { api } from "@/server/http/api";
import { respondClarify } from "@/server/assistant";
import { CLARIFY_ANSWER_MAX } from "@/integrations/hermes/service";

const bodySchema = z.object({ answer: z.string().trim().min(1).max(CLARIFY_ANSWER_MAX), requestId: z.string().min(1).max(256) });

/** Answer a Hermes clarify question (one tap on a choice, or a typed answer). */
export const POST = api<z.infer<typeof bodySchema>, { runId: string }>(
  ({ params, body, user, correlationId }) => respondClarify(user, params.runId, body, correlationId),
  {
    cap: "hermes.chat",
    body: bodySchema,
  },
);
