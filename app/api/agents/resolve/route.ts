import { api } from "@/server/http/api";
import { resolveAgentForNode } from "@/server/agents/routing";

export const dynamic = "force-dynamic";

/** Who answers for new chats and AI actions under `?nodeId=` (area pages' agent chip). Only your own items are walked. */
export const GET = api(
  ({ req, user }) => {
    const nodeId = (req.nextUrl.searchParams.get("nodeId") ?? "").slice(0, 80);
    return resolveAgentForNode(user.id, nodeId || null);
  },
  { cap: "hermes.chat" },
);
