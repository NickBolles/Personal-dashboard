import { api } from "@/server/http/api";
import { z } from "zod";
import { runAnyway } from "@/server/ai/jobs";
import { kickRunner } from "@/server/ai/runner";

/** One-tap budget override for a budget-blocked job (audited ai.budget_override). */
export const POST = api<Record<string, never>, { id: string }>(
  ({ user, params, correlationId }) => {
    const job = runAnyway(user.id, params.id, correlationId);
    kickRunner();
    return job;
  },
  { capAll: ["work.use", "work.ai"], body: z.object({}).strict() },
);
