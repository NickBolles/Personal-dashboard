import { api } from "@/server/http/api";
import { stopRun } from "@/server/assistant";

export const POST = api<undefined, { runId: string }>(({ params, user, correlationId }) => stopRun(user, params.runId, correlationId), { cap: "hermes.chat" });
