import { api } from "@/server/http/api";
import { reflectionPrompt } from "@/server/workflows/outputs";

export const dynamic = "force-dynamic";

/** "Prompt me" (D10): one reflection question from this run's own notes (a proposal; answering files it). */
export const POST = api<undefined, { runId: string }>(
  ({ user, params, correlationId }) => reflectionPrompt(user, { userId: user.id, correlationId }, params.runId),
  { capAll: ["work.use", "work.ai"] },
);
