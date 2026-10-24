import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireCap } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { listSessions } from "@/server/assistant";
import { isLocalSession } from "@/lib/assistant";
import type { SessionSummary } from "@/lib/hermes";
import {
  suggestFiling,
  type ConversationOption,
  type ConversationsResponse,
  type fileConversationSchema,
  type UnfiledResponse,
  type WorkStatus,
} from "@/lib/work";
import type { z } from "zod";
import { addLink, ensureMiscellaneous, listItems } from "./store";

/**
 * Conversations for the Work hub: the picker and the "Unfiled conversations"
 * inbox. Sessions come only from server/assistant (Hermes + Claude-direct),
 * never from integrations/hermes directly. Suggestions are deterministic
 * title-word matches (lib/work.ts suggestFiling): no model calls.
 */

const TIMEOUT_MS = 6000;
const UNFILED_LIMIT = 20;

async function sessionsFor(user: CurrentUser): Promise<{ sessions: SessionSummary[]; unavailable: string[] }> {
  try {
    const r = await Promise.race([
      listSessions(user, {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.()),
    ]);
    return { sessions: r.sessions, unavailable: r.unavailable };
  } catch {
    // A failing assistant backend is reported, never shown as "no conversations".
    return { sessions: [], unavailable: ["Hermes"] };
  }
}

/** session id → your items that link it */
function linkedItems(userId: string) {
  const rows = getDb()
    .select({ targetId: schema.workLinks.targetId, itemId: schema.workItems.id, title: schema.workItems.title })
    .from(schema.workLinks)
    .innerJoin(schema.workItems, eq(schema.workItems.id, schema.workLinks.itemId))
    .where(and(eq(schema.workItems.userId, userId), eq(schema.workLinks.kind, "chat_session")))
    .all();
  const out = new Map<string, { id: string; title: string }[]>();
  for (const r of rows) if (r.targetId) out.set(r.targetId, [...(out.get(r.targetId) ?? []), { id: r.itemId, title: r.title }]);
  return out;
}

function toOption(s: SessionSummary, linked: Map<string, { id: string; title: string }[]>): ConversationOption {
  return {
    id: s.id,
    title: s.title || s.preview?.slice(0, 80) || "Untitled conversation",
    preview: s.preview ?? null,
    lastActiveAt: s.lastActiveAt ?? s.startedAt ?? null,
    backend: isLocalSession(s.id) ? "claude" : "hermes",
    readOnly: !!s.readOnly,
    linkedItems: linked.get(s.id) ?? [],
  };
}

/** Your conversations (most recent first), optionally filtered by title/preview text. */
export async function listConversations(user: CurrentUser, q?: string | null): Promise<ConversationsResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable } = await sessionsFor(user);
  const linked = linkedItems(user.id);
  const needle = q?.trim().toLowerCase();
  const conversations = sessions
    .filter((s) => !s.archived)
    .map((s) => toOption(s, linked))
    .filter((c) => !needle || `${c.title} ${c.preview ?? ""}`.toLowerCase().includes(needle))
    .slice(0, 50);
  return { conversations, unavailable };
}

/** Recent conversations of yours that aren't linked to any work item, with filing suggestions. */
export async function unfiledConversations(user: CurrentUser): Promise<UnfiledResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable } = await sessionsFor(user);
  const linked = linkedItems(user.id);
  const items = listItems(user.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const path = (id: string) => {
    const parts: string[] = [];
    for (let c = byId.get(id); c && parts.length < 8; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title);
    return parts.join(" › ");
  };
  const candidates = items.map((i) => ({ id: i.id, title: i.title, path: path(i.id), status: i.status as WorkStatus, builtIn: i.builtIn }));
  const open = sessions.filter((s) => !s.archived && !s.readOnly && !linked.has(s.id));
  return {
    total: open.length,
    unavailable,
    conversations: open.slice(0, UNFILED_LIMIT).map((s) => {
      const o = toOption(s, linked);
      return { ...o, suggestions: suggestFiling(o.title, candidates) };
    }),
  };
}

/** One-click filing: link the conversation as a `source` of the item (or of Miscellaneous). */
export async function fileConversation(user: CurrentUser, body: z.infer<typeof fileConversationSchema>, correlationId: string) {
  requireCap(user, "hermes.chat");
  const itemId = body.itemId ?? ensureMiscellaneous(user.id).id;
  const link = await addLink(user, itemId, { kind: "chat_session", targetId: body.sessionId, role: body.role ?? "source" }, correlationId);
  return { link, itemId };
}
