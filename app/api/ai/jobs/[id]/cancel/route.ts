import { api } from "@/server/http/api";
import { z } from "zod";
import { requestCancel } from "@/server/ai/jobs";
import { kickRunner } from "@/server/ai/runner";

/** Queued jobs cancel at once; running ones show "Stopping…" and end cancelled only after Hermes confirms. */
export const POST = api<Record<string, never>, { id: string }>(
  ({ user, params, correlationId }) => {
    const job = requestCancel(user.id, params.id, correlationId);
    kickRunner();
    return job;
  },
  { capAll: ["work.use", "work.ai"], body: z.object({}).strict() },
);
