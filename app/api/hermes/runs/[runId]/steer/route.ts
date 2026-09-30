import { z } from "zod";
import { api } from "@/server/http/api";
import { steerRun } from "@/integrations/hermes/service";

const bodySchema = z.object({ input: z.string().min(1).max(5000) });

export const POST = api<z.infer<typeof bodySchema>, { runId: string }>(({ params, body, user, correlationId }) =>
  steerRun(user, params.runId, body.input, correlationId),
  { body: bodySchema },
);
