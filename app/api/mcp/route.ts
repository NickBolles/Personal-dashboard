import { NextResponse, type NextRequest } from "next/server";
import { bearerToken } from "@/server/auth";
import { checkThrottle, clearFailures, recordFailure, throttleKeys } from "@/server/auth/throttle";
import { AuthError } from "@/server/auth/errors";
import { clientIp } from "@/server/http/origin";
import { readBodyCapped, jsonError, toErrorResponse } from "@/server/http/api";
import { newId } from "@/server/crypto";
import { config } from "@/server/config";
import { agentFromToken } from "@/server/agent-access/tokens";
import { handleMcp, MCP_MAX_BODY_BYTES } from "@/server/agent-access/mcp";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Jarvis MCP endpoint (docs/agent-tools.md). Authenticated ONLY by a scoped agent token
 * (Authorization: Bearer jva_…): cookies, proxy identity and device tokens are not accepted here,
 * and agent tokens are not accepted anywhere else. A browser Origin other than Jarvis' own is
 * refused (DNS-rebinding guard from the MCP spec). Bad tokens count toward the sign-in throttle.
 */
export async function POST(req: NextRequest) {
  const correlationId = newId();
  try {
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin && origin !== config.publicOrigin) return jsonError(403, "Cross-origin request rejected", "csrf");
    const keys = throttleKeys("agent", clientIp(req.headers));
    checkThrottle(keys);
    const agent = agentFromToken(bearerToken(req.headers));
    if (!agent) {
      recordFailure(keys);
      return NextResponse.json(
        { error: "Agent token required", code: "unauthenticated" },
        { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
      );
    }
    clearFailures(keys.filter((k) => !k.startsWith("global:")));
    const text = (await readBodyCapped(req, MCP_MAX_BODY_BYTES)).toString("utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: NO_STORE });
    }
    const res = await handleMcp(agent, raw, correlationId);
    if (!res) return new Response(null, { status: 202, headers: NO_STORE });
    return NextResponse.json(res, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError && err.code === "throttled") return jsonError(429, "Too many failed attempts; try again later", "throttled");
    return toErrorResponse(err, correlationId);
  }
}

/** No server-initiated stream (JSON responses only) and no sessions to end. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST", ...NO_STORE } });
}
export const DELETE = GET;
