import { api } from "@/server/http/api";
import { fileSuggestion } from "@/server/work/inbox";

/** "File it" (Report ready push action): file a capture under its triage suggestion. Idempotent. */
export const POST = api<undefined, { id: string }>(({ user, params, correlationId }) => fileSuggestion(user, params.id, correlationId), { cap: "work.use" });
