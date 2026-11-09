import type { z } from "zod";
import { api } from "@/server/http/api";
import { resumeInterruptedRuns, resumeSchema } from "@/server/work/resume-runs";

/**
 * Resume all (owner-confirmed): one resume prompt per interrupted run's session, through the normal chat run
 * path (or a steer when a turn is still in flight). Owner session only; idempotent per interruption.
 */
export const POST = api<z.infer<typeof resumeSchema>>(({ user, body, correlationId }) => resumeInterruptedRuns(user, body.refs, correlationId), {
  capAll: ["work.use", "hermes.chat"],
  body: resumeSchema,
});
