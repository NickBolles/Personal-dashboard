import { api } from "@/server/http/api";
import { stopRun } from "@/integrations/hermes/service";

export const POST = api<undefined, { runId: string }>(({ params, user, correlationId }) => stopRun(user, params.runId, correlationId));
