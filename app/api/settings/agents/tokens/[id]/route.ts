import type { z } from "zod";
import { api } from "@/server/http/api";
import { updateAgentScopesSchema } from "@/lib/agent-access";
import { revokeAgentToken, updateAgentTokenScopes } from "@/server/agent-access/tokens";

export const dynamic = "force-dynamic";

/** Change an agent token's scopes (same token, no rotation): the agent's next MCP call uses them. */
export const PATCH = api<z.infer<typeof updateAgentScopesSchema>, { id: string }>(
  ({ user, params, body, correlationId }) => ({ token: updateAgentTokenScopes(user, params.id, body.scopes, correlationId) }),
  { cap: "admin", body: updateAgentScopesSchema },
);

/** Revoke an agent token (kill switch): its next MCP call is refused. */
export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => ({ token: revokeAgentToken(user, params.id, correlationId) }), {
  cap: "admin",
});
