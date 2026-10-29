import { and, eq } from "drizzle-orm";
import { api } from "@/server/http/api";
import { can } from "@/server/access";
import { getDb, schema } from "@/server/db";
import { composerTarget } from "@/server/agents/composer";
import { resolveAgent } from "@/server/agents/routing";
import { NODE_ID_RE } from "@/lib/composer-target";

export const dynamic = "force-dynamic";

/**
 * The global composer's target: `?nodeId=` (an Areas page) or `?sessionId=` (a conversation, via the
 * node it is filed under). Returns the node (title, path) and who answers there. Only your own items.
 */
export const GET = api(
  ({ req, user }) => {
    if (!can(user, "work.use")) return { node: null, agent: resolveAgent(null) };
    const p = req.nextUrl.searchParams;
    let nodeId = p.get("nodeId");
    const sessionId = p.get("sessionId");
    if (!nodeId && sessionId && sessionId.length <= 200) {
      const row = getDb()
        .select({ parentId: schema.workItems.parentId })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.userId, user.id), eq(schema.workItems.sessionId, sessionId)))
        .get();
      nodeId = row?.parentId ?? null;
    }
    return composerTarget(user.id, nodeId && NODE_ID_RE.test(nodeId) ? nodeId : null);
  },
  { cap: "hermes.chat" },
);
