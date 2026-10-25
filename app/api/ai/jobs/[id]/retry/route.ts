import { api } from "@/server/http/api";
import type { z } from "zod";
import { retrySchema } from "@/lib/ai";
import { retryJob } from "@/server/ai/jobs";
import { kickRunner } from "@/server/ai/runner";

export const POST = api<z.infer<typeof retrySchema>, { id: string }>(
  ({ user, params, body, correlationId }) => {
    const r = retryJob(user.id, params.id, body.budgetOverride, correlationId);
    kickRunner();
    return r.job;
  },
  { capAll: ["work.use", "work.ai"], body: retrySchema },
);
