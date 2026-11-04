import { api } from "@/server/http/api";
import { revokeAgentToken } from "@/server/agent-access/tokens";

export const dynamic = "force-dynamic";

/** Revoke an agent token (kill switch): its next MCP call is refused. */
export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => ({ token: revokeAgentToken(user, params.id, correlationId) }), {
  cap: "admin",
});
