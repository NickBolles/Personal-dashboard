import "server-only";
import { z, ZodError } from "zod";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { withVia } from "@/server/work/actor";
import { rateLimited, type AgentPrincipal } from "./tokens";
import { TOOLS, TOOL_BY_NAME } from "./tools";
import { activeScheduledRunFor } from "@/server/agents/schedules";

/** Tools that write directly (not proposals/decisions/run bookkeeping): off while the profile's scheduled run is active. */
export const SCHEDULED_GUARDED = new Set(["jarvis_create_item", "jarvis_update_item", "jarvis_add_note", "jarvis_link", "jarvis_file_conversation"]);

/**
 * Jarvis MCP server (streamable HTTP, JSON responses; docs/agent-tools.md). Stateless: every POST
 * carries one JSON-RPC message and the agent token. Supports initialize, ping, tools/list and
 * tools/call; notifications get 202. Batches are refused (MCP 2025-06-18 dropped them).
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** Request body cap for /api/mcp (tool inputs are capped far below this by their schemas). */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

type RpcId = string | number | null;
type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(200), z.number()]).optional(),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcId, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data ? { data } : {}) },
});

let cachedList: unknown[] | null = null;
export function toolList() {
  cachedList ??= TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: `${t.description} (scope: ${t.scope})`, inputSchema: schema };
  });
  return cachedList;
}

const textResult = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : { structuredContent: value }),
});

/** Handle one JSON-RPC message. Returns null for notifications (HTTP 202). */
export async function handleMcp(agent: AgentPrincipal, raw: unknown, correlationId: string): Promise<RpcResponse | null> {
  if (Array.isArray(raw)) return fail(null, -32600, "Batches aren't supported");
  const parsed = rpcSchema.safeParse(raw);
  if (!parsed.success) return fail(null, -32600, "Invalid JSON-RPC request");
  const { id, method, params } = parsed.data;
  if (id === undefined) return null; // notification (initialized, cancelled, …)
  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jarvis", version: "1.0.0" },
        instructions:
          "Jarvis work items for the owner. Writes are attributed to you, logged and undoable. You can't settle, archive, move, split, merge or delete — propose those with jarvis_request_change. Finance is never available.",
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toolList().filter((t) => agent.scopes.includes(TOOL_BY_NAME.get((t as { name: string }).name)!.scope)) });
    case "tools/call":
      return ok(id, await callTool(agent, params ?? {}, correlationId));
    default:
      return fail(id, -32601, "Method not found");
  }
}

async function callTool(agent: AgentPrincipal, params: Record<string, unknown>, correlationId: string) {
  const name = typeof params.name === "string" ? params.name.slice(0, 100) : "";
  const t = TOOL_BY_NAME.get(name);
  const log = (result: "ok" | "rejected" | "error", code?: string) =>
    audit({
      actor: agent.via,
      action: "agent.mcp",
      source: "agent",
      sourceRecord: name || "?",
      result,
      correlationId,
      detail: { tokenId: agent.tokenId, ...(code ? { code } : {}) },
    });
  if (!t) {
    log("rejected", "unknown_tool");
    return textResult({ error: "unknown_tool", message: `No tool named ${name || "(missing)"}` }, true);
  }
  if (!agent.scopes.includes(t.scope)) {
    log("rejected", "scope");
    return textResult({ error: "forbidden", message: `This token lacks the ${t.scope} scope` }, true);
  }
  if (SCHEDULED_GUARDED.has(t.name) && activeScheduledRunFor(agent.user.id, agent.profile)) {
    // A scheduled run's direct writes would bypass the area's autonomy policy: route them through the
    // run's proposals block, where Jarvis applies Propose-only / Act-on-low-risk (#230).
    log("rejected", "scheduled_run");
    return textResult(
      {
        error: "scheduled_run",
        message:
          "A scheduled run for this agent is active, so direct writes are off. List the change in the jarvis-proposals block instead; Jarvis applies the area's autonomy policy (decisions in Needs you, low-risk changes only where allowed).",
      },
      true,
    );
  }
  if (rateLimited(agent.tokenId)) {
    log("rejected", "rate_limited");
    return textResult({ error: "rate_limited", message: "Too many calls; slow down and retry in a minute" }, true);
  }
  try {
    const args = t.input.parse(params.arguments ?? {});
    const value = await withVia(agent.via, () => t.run(args, { agent, correlationId }));
    log("ok");
    return textResult(value);
  } catch (err) {
    if (err instanceof ZodError) {
      log("rejected", "validation");
      return textResult({ error: "validation", issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) }, true);
    }
    if (err instanceof HttpError) {
      log(err.status === 403 || err.status === 404 ? "rejected" : "error", err.code);
      return textResult({ error: err.code, message: err.message }, true);
    }
    console.error(`[jarvis] mcp tool ${name} failed ${correlationId}`, err instanceof Error ? err.message : "error");
    log("error", "internal");
    return textResult({ error: "internal", message: "Something went wrong", correlationId }, true);
  }
}
