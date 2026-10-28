import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { can, type Capable } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { createSession, forkSession, listSessions, updateSession } from "@/server/assistant";
import type { ForkInput } from "@/integrations/hermes/service";
import type { AssistantBackend } from "@/lib/assistant";
import type { SessionSummary } from "@/lib/hermes";
import { parseAreaSettings as parseSettings } from "@/lib/work";
import { conversationNodes, placeConversation } from "@/server/work/store";
import { conversationPlacement } from "@/server/work/conversations";
import { areaDefaultsFor, assertAreaOwned } from "@/server/references";
import { requestedAgentFor, resolveAgent, resolveAgentForNode } from "@/server/agents/routing";
import { sessionProfile } from "@/integrations/hermes/service";
import { isLocalSession } from "@/lib/assistant";
import type { AgentResolution } from "@/lib/agents";

/**
 * Areas (phase 4) glue between the assistant layer (server/assistant: Hermes
 * owns conversation content) and the Areas tree (server/work: Jarvis owns
 * placement, lineage and lifecycle). Kept out of both so neither imports the
 * other in a cycle.
 */

type Viewer = CurrentUser & Capable;

/**
 * "New chat" from anywhere: the conversation starts immediately and lands in
 * Miscellaneous, or under `areaId` when started from inside an area or item.
 * Zero filing (owner decision). Placement never blocks the chat: if it fails
 * the conversation simply shows up as unfiled.
 */
export async function startConversation(user: Viewer, v: { title?: string; backend?: AssistantBackend; areaId?: string | null }, correlationId: string) {
  const work = can(user, "work.use");
  if (v.areaId && work) assertAreaOwned(user, v.areaId);
  const defaults = v.areaId && work ? areaDefaultsForItem(user, v.areaId) : null;
  // Settings → Agents: a chat started under an area runs on that area's Hermes profile (inherited up the tree).
  const agent = v.areaId && work ? resolveAgentForNode(user.id, v.areaId) : resolveAgent(null);
  const session = await createSession(user, v.title, v.backend ?? defaults?.settings.defaultBackend ?? undefined, agent.routed ? agent.profile : null);
  let placedIn: string | null = null;
  if (work) {
    try {
      placedIn = placeConversation(
        user,
        { sessionId: session.id, parentId: v.areaId ?? null, title: session.title || v.title || "New conversation" },
        correlationId,
      ).parentId;
    } catch {
      placedIn = null;
    }
  }
  return { ...session, placedIn };
}

/** Area settings for an item (its area's), by item id. */
function areaDefaultsForItem(user: CurrentUser, itemId: string) {
  const row = getDb()
    .select({ sessionId: schema.workItems.sessionId })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, itemId), eq(schema.workItems.userId, user.id)))
    .get();
  if (row?.sessionId) return areaDefaultsFor(user, row.sessionId);
  // Walk up from the item itself.
  const rows = getDb().select().from(schema.workItems).where(eq(schema.workItems.userId, user.id)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  let cur = byId.get(itemId);
  for (let n = 0; cur?.parentId && n < 100; n++) cur = byId.get(cur.parentId);
  if (!cur) return null;
  return { area: { id: cur.id, title: cur.title, builtIn: !!cur.systemKey }, settings: parseSettings(cur.settings) };
}

/** Fork: the new conversation lands next to its parent in the tree, with `forked_from` lineage. */
export async function forkConversation(user: Viewer, id: string, input: ForkInput, correlationId: string) {
  const result = await forkSession(user, id, input, correlationId);
  const child: SessionSummary = result.session;
  if (can(user, "work.use") && child?.id) {
    try {
      const parentNode = conversationNodes(user.id).get(id);
      placeConversation(
        user,
        { sessionId: child.id, parentId: parentNode?.parentId ?? null, title: child.title || input.title || "Fork", forkedFromSessionId: id },
        correlationId,
      );
    } catch {
      /* placement is best effort; the fork exists either way */
    }
  }
  return result;
}

/** Session PATCH with explicit share/unshare audit entries (sharing is read-only for the household). */
export async function patchConversation(
  user: Viewer,
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; shared?: boolean },
  correlationId: string,
) {
  const before =
    patch.shared === undefined
      ? null
      : getDb().select({ shared: schema.sessionMeta.shared }).from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, id)).get();
  const out = await updateSession(user, id, patch, correlationId);
  if (patch.shared !== undefined && Boolean(before?.shared) !== patch.shared)
    audit({
      actor: user.id,
      action: patch.shared ? "conversation.share" : "conversation.unshare",
      source: id.startsWith("loc_") ? "claude" : "hermes",
      sourceRecord: id,
      result: "ok",
      correlationId,
    });
  return out;
}

/** Your conversations shared with the household (Settings list). Titles from the assistant when it answers, else the tree. */
export async function sharedConversations(user: Viewer) {
  const rows = getDb()
    .select({ id: schema.sessionMeta.sessionId, title: schema.sessionMeta.titleOverride })
    .from(schema.sessionMeta)
    .where(and(eq(schema.sessionMeta.userId, user.id), eq(schema.sessionMeta.shared, true)))
    .all();
  if (!rows.length) return { conversations: [] as { id: string; title: string; lastActiveAt: string | null }[], unavailable: [] as string[] };
  let sessions: SessionSummary[] = [];
  let unavailable: string[] = [];
  try {
    const r = await Promise.race([
      listSessions(user, { includeArchived: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000).unref?.()),
    ]);
    sessions = r.sessions;
    unavailable = r.unavailable;
  } catch {
    unavailable = ["Hermes"];
  }
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const nodes = can(user, "work.use") ? conversationNodes(user.id) : new Map();
  return {
    unavailable,
    conversations: rows.map((r) => {
      const s = byId.get(r.id);
      return { id: r.id, title: s?.title || r.title || nodes.get(r.id)?.title || "Conversation", lastActiveAt: s?.lastActiveAt ?? null };
    }),
  };
}

/** The conversation header's Areas context: where it sits, its node, filing suggestions and the area's defaults. */
export function conversationAreaContext(user: Viewer, sessionId: string, title: string) {
  if (!can(user, "work.use")) return { enabled: false as const };
  const p = conversationPlacement(user, sessionId, title);
  const d = areaDefaultsFor(user, sessionId);
  return { enabled: true as const, ...p, area: d?.area ?? null, settings: d?.settings ?? null, agent: conversationAgent(user, sessionId, p.node?.id ?? null) };
}

/**
 * Who answers in this conversation (composer agent chip). A conversation stays
 * on the profile it was created on; when its area now routes elsewhere it says so.
 */
export function conversationAgent(user: CurrentUser, sessionId: string, nodeId: string | null): AgentResolution | null {
  if (isLocalSession(sessionId)) return null;
  const actual = sessionProfile(sessionId);
  const want = nodeId ? requestedAgentFor(user.id, nodeId) : { agentMode: null, from: null };
  if (actual) return { requested: want.agentMode ?? actual, profile: actual, routed: true, reason: "routed", from: want.from };
  const r = resolveAgent(want.agentMode, want.from);
  return r.routed ? { ...r, profile: null, routed: false, reason: "started_on_default" } : r;
}
