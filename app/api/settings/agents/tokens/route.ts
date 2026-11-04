import type { z } from "zod";
import { api } from "@/server/http/api";
import { mintAgentTokenSchema } from "@/lib/agent-access";
import { listAgentTokens, mintAgentToken } from "@/server/agent-access/tokens";

export const dynamic = "force-dynamic";

/** Settings → Agents → Agent access (admin): list tokens (never the token itself, only its last 4). */
export const GET = api(({ user }) => ({ tokens: listAgentTokens(user.id) }), { cap: "admin" });

/** Mint a scoped agent token. The response carries the token ONCE; only its hash is stored. */
export const POST = api<z.infer<typeof mintAgentTokenSchema>>(({ user, body, correlationId }) => mintAgentToken(user, body, correlationId), {
  cap: "admin",
  body: mintAgentTokenSchema,
});
