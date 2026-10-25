import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireCap } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { getSessionDetail, listSessions } from "@/server/assistant";
import { isLocalSession } from "@/lib/assistant";
import type { SessionSummary } from "@/lib/hermes";
import {
  suggestFiling,
  type ConversationFilter,
  type ConversationListResponse,
  type ConversationOption,
  type ConversationPlacement,
  type ConversationsResponse,
  type fileConversationSchema,
  type UnfiledResponse,
  type WorkItem,
  type WorkStatus,
} from "@/lib/work";
import type { z } from "zod";
import { listItems, placeConversation, syncConversationTitles, type OpOut } from "./store";

/**
 * Conversations in the Areas tree: the picker, the conversations view (All /
 * Unfiled) and the Inbox's unplaced conversations. Sessions come only from
 * server/assistant (Hermes + Claude-direct), never from integrations/hermes
 * directly. Suggestions are deterministic title-word matches (lib/work.ts
 * suggestFiling): no model calls.
 *
 * Placement: a conversation is in the tree when it has a conversation node or
 * an item links it. "Unfiled" (the conversations view) = not in the tree, or
 * only in Miscellaneous; the Inbox lists only the ones not in the tree at all
 * (new chats land in Miscellaneous automatically, which never nags).
 */

const TIMEOUT_MS = 6000;
const UNFILED_LIMIT = 20;
const LIST_LIMIT = 100;

async function sessionsFor(user: CurrentUser): Promise<{ sessions: SessionSummary[]; unavailable: string[] }> {
  try {
    const r = await Promise.race([
      listSessions(user, {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.()),
    ]);
    syncConversationTitles(user.id, r.sessions);
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

type Ctx = { linked: Map<string, { id: string; title: string }[]>; items: WorkItem[]; byId: Map<string, WorkItem>; nodes: Map<string, WorkItem> };

function context(userId: string): Ctx {
  const items = listItems(userId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const nodes = new Map(items.filter((i) => i.kind === "conversation" && i.sessionId).map((i) => [i.sessionId!, i]));
  return { linked: linkedItems(userId), items, byId, nodes };
}

function pathOf(ctx: Ctx, id: string) {
  const parts: string[] = [];
  for (let c = ctx.byId.get(id); c && parts.length < 8; c = c.parentId ? ctx.byId.get(c.parentId) : undefined) parts.unshift(c.title);
  return parts.join(" › ");
}

/**
 * Where a conversation sits: its node, unless that node is only in
 * Miscellaneous and an item elsewhere links it (then it counts as filed
 * there); else the first visible item linking it.
 */
function placementOf(ctx: Ctx, sessionId: string): ConversationPlacement | null {
  const node = ctx.nodes.get(sessionId);
  const isMisc = (id: string) => {
    const i = ctx.byId.get(id);
    return !!i && i.builtIn && i.parentId === null;
  };
  const nodePlacement = node?.parentId ? { nodeId: node.id, parentId: node.parentId, path: pathOf(ctx, node.parentId), inMisc: isMisc(node.parentId) } : null;
  if (nodePlacement && !nodePlacement.inMisc) return nodePlacement;
  const links = (ctx.linked.get(sessionId) ?? []).filter((l) => ctx.byId.has(l.id));
  const link = links.find((l) => !isMisc(l.id)) ?? links[0];
  if (link && (!nodePlacement || !isMisc(link.id))) return { nodeId: node?.id ?? null, parentId: link.id, path: pathOf(ctx, link.id), inMisc: isMisc(link.id) };
  return nodePlacement;
}

function toOption(s: SessionSummary, ctx: Ctx): ConversationOption {
  return {
    id: s.id,
    title: s.title || s.preview?.slice(0, 80) || "Untitled conversation",
    preview: s.preview ?? null,
    lastActiveAt: s.lastActiveAt ?? s.startedAt ?? null,
    backend: isLocalSession(s.id) ? "claude" : "hermes",
    readOnly: !!s.readOnly,
    linkedItems: ctx.linked.get(s.id) ?? [],
    placement: placementOf(ctx, s.id),
    shared: !!s.shared,
  };
}

function candidates(ctx: Ctx) {
  return ctx.items
    .filter((i) => i.kind !== "conversation" && i.kind !== "note")
    .map((i) => ({ id: i.id, title: i.title, path: pathOf(ctx, i.id), status: i.status as WorkStatus, builtIn: i.builtIn }));
}

const isUnfiled = (o: ConversationOption) => !o.readOnly && (!o.placement || o.placement.inMisc);

/** Your conversations (most recent first), optionally filtered by title/preview text. */
export async function listConversations(user: CurrentUser, q?: string | null): Promise<ConversationsResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable } = await sessionsFor(user);
  const ctx = context(user.id);
  const needle = q?.trim().toLowerCase();
  const conversations = sessions
    .filter((s) => !s.archived)
    .map((s) => toOption(s, ctx))
    .filter((c) => !needle || `${c.title} ${c.preview ?? ""}`.toLowerCase().includes(needle))
    .slice(0, 50);
  return { conversations, unavailable };
}

/** The conversations view of the Areas tree: All or Unfiled (not in the tree, or only in Miscellaneous), with filing suggestions. */
export async function conversationList(user: CurrentUser, filter: ConversationFilter, q?: string | null): Promise<ConversationListResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable } = await sessionsFor(user);
  const ctx = context(user.id);
  const cands = candidates(ctx);
  const needle = q?.trim().toLowerCase();
  const all = sessions.filter((s) => !s.archived).map((s) => toOption(s, ctx));
  const unfiledCount = all.filter(isUnfiled).length;
  const conversations = all
    .filter((c) => filter === "all" || isUnfiled(c))
    .filter((c) => !needle || `${c.title} ${c.preview ?? ""} ${c.placement?.path ?? ""}`.toLowerCase().includes(needle))
    .slice(0, LIST_LIMIT)
    .map((c) => ({ ...c, suggestions: isUnfiled(c) ? suggestFiling(c.title, cands) : [] }));
  return { conversations, unfiledCount, unavailable };
}

/** Recent conversations of yours that aren't in the tree at all (not dismissed), with filing suggestions: the Inbox's list. */
export async function unfiledConversations(user: CurrentUser): Promise<UnfiledResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable } = await sessionsFor(user);
  const ctx = context(user.id);
  const cands = candidates(ctx);
  // Dismissed from the Inbox (only the id is kept; Hermes owns the conversation).
  const dismissed = new Set(
    getDb()
      .select({ id: schema.workInbox.externalId })
      .from(schema.workInbox)
      .where(and(eq(schema.workInbox.userId, user.id), eq(schema.workInbox.source, "conversation")))
      .all()
      .map((r) => r.id),
  );
  const open = sessions.filter((s) => !s.archived && !s.readOnly && !dismissed.has(s.id) && !placementOf(ctx, s.id));
  return {
    total: open.length,
    unavailable,
    conversations: open.slice(0, UNFILED_LIMIT).map((s) => {
      const o = toOption(s, ctx);
      return { ...o, suggestions: suggestFiling(o.title, cands) };
    }),
  };
}

/** Placement of one conversation (the conversation header's area chip), with filing suggestions. */
export function conversationPlacement(user: CurrentUser, sessionId: string, title: string) {
  const ctx = context(user.id);
  const placement = placementOf(ctx, sessionId);
  const node = ctx.nodes.get(sessionId) ?? null;
  return {
    placement,
    node: node ? { id: node.id, status: node.status } : null,
    suggestions: !placement || placement.inMisc ? suggestFiling(title, candidates(ctx)) : [],
  };
}

/**
 * One-tap filing: the conversation's node goes under the item (or
 * Miscellaneous), created if it has none. The access check is reading the
 * conversation through the assistant layer; if the assistant doesn't answer,
 * filing is refused rather than trusting the id.
 */
export async function fileConversation(user: CurrentUser, body: z.infer<typeof fileConversationSchema>, correlationId: string) {
  requireCap(user, "hermes.chat");
  let title = body.title ?? "";
  try {
    const d = await Promise.race([
      getSessionDetail(user, body.sessionId),
      new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), TIMEOUT_MS).unref?.()),
    ]);
    if (d.session.readOnly) throw new HttpError(403, "read_only", "Fork a shared conversation to file it");
    title = d.session.title || title;
  } catch (e) {
    if (e instanceof HttpError && e.code === "read_only") throw e;
    if (e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 400)) throw new HttpError(404, "not_found", "Conversation not found");
    if (e instanceof Error && "kind" in e && (e as { kind: string }).kind === "not_found") throw new HttpError(404, "not_found", "Conversation not found");
    throw new HttpError(503, "assistant_unavailable", "Couldn't reach the assistant to check that conversation. Try again.");
  }
  const out: OpOut = {};
  const item = placeConversation(user, { sessionId: body.sessionId, parentId: body.itemId, title: title || "Conversation" }, correlationId, out);
  return { item, itemId: item.parentId, op: out.op ?? null };
}
