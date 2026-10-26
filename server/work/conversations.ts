import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { requireCap } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { getSessionSummary, listLocalConversations, listSessions, sessionAccess } from "@/server/assistant";
import { userById } from "@/server/auth";
import { noteIndexFailure, readIndex, recentIndexUsers, touchIndex, writeIndex, type IndexEntry } from "./conversation-index";
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

/**
 * Hermes' session list is slow: 8.6 s for the 100-row window in prod and
 * ~3.7 s even for 20 rows (its query ranks every session before applying the
 * limit). So the Areas views never wait for it when they don't have to:
 *
 * - Stale-while-revalidate: each person's last list is persisted
 *   (conversation_index) and served at once, access re-checked per row, while
 *   a background refresh brings it up to date. The views show "Updating…"
 *   (not a warning) and poll until it lands.
 * - Progressive first load: with no index yet, the fast first page (20 rows)
 *   is returned and stored, and the full 100-row window follows in the
 *   background.
 * - Warm: the standalone dispatcher tick refreshes the index of anyone who
 *   used it in the last week every few minutes (warmConversationIndexes).
 *
 * The 25 s budget is for a refresh that someone actually waits on (a cold
 * start, or a list older than STALE_OK_MS); it must sit above
 * HermesSessionClient.list's own 20 s, or a slow list reads as "Hermes didn't
 * answer".
 */
export const LIST_BUDGET_MS = 25_000;
/** Filing only needs the one session (GET /api/sessions/:id), not its transcript. */
const DETAIL_BUDGET_MS = 10_000;
/** A list younger than this is served without asking Hermes again. */
export const FRESH_MS = 60_000;
/** Up to this age a cached list is shown at once with "Updating…", never the "didn't answer" warning. */
export const STALE_OK_MS = 30 * 60_000;
/** The warmer refreshes an index once it is this old. */
export const WARM_EVERY_MS = 3 * 60_000;
/** People who haven't opened a conversation view for this long aren't warmed. */
const WARM_IDLE_MS = 7 * 24 * 60 * 60_000;
/** Right after a failed refresh, don't make the next request wait for another one. */
const RETRY_AFTER_FAILURE_MS = 60_000;
const UNFILED_LIMIT = 20;
const LIST_LIMIT = 100;

type Listed = { sessions: SessionSummary[]; unavailable: string[]; updating: boolean; cachedAt: string | null };

/** One upstream refresh (or first page) per person at a time: the views, the unfiled count, the Inbox and the warmer share it. */
const refreshing = new Map<string, Promise<boolean>>();
const firstPages = new Map<string, Promise<Listed>>();
const warming = new Set<Promise<unknown>>();

export function __resetConversationCache() {
  refreshing.clear();
  firstPages.clear();
  warming.clear();
}

/** Wait for any in-flight refreshes (tests). */
export async function __settleConversationRefreshes() {
  while (refreshing.size || firstPages.size || warming.size) await Promise.allSettled([...refreshing.values(), ...firstPages.values(), ...warming]);
}

function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const errKind = (e: unknown) => (e instanceof Error && e.message === "timeout" ? "timeout" : "error");

/** Fetch the full window and persist it. Resolves true when Hermes answered; never rejects. */
function refresh(user: CurrentUser): Promise<boolean> {
  let p = refreshing.get(user.id);
  if (!p) {
    p = withBudget(listSessions(user, {}), LIST_BUDGET_MS)
      .then((r) => {
        syncConversationTitles(user.id, r.sessions);
        if (r.unavailable.length) {
          noteIndexFailure(user.id, "unavailable");
          return false;
        }
        writeIndex(user.id, r.sessions, true);
        return true;
      })
      .catch((e) => {
        noteIndexFailure(user.id, errKind(e));
        return false;
      })
      .finally(() => refreshing.delete(user.id));
    refreshing.set(user.id, p);
  }
  return p;
}

/** The person's own Claude-direct conversations (local, fast) merged with cached Hermes rows they can still see. */
function fromIndex(user: CurrentUser, hit: IndexEntry, unavailable: string[]): Listed {
  const remote = hit.sessions.filter((s) => !isLocalSession(s.id) && sessionAccess(user, s.id));
  return {
    sessions: sortRecent([...remote, ...listLocalConversations(user)]),
    unavailable,
    updating: refreshing.has(user.id),
    cachedAt: hit.refreshedAt ? new Date(hit.refreshedAt).toISOString() : null,
  };
}

/** No index yet: the fast 20-row first page now, the full window in the background. */
function firstPage(user: CurrentUser): Promise<Listed> {
  let p = firstPages.get(user.id);
  if (!p) {
    p = withBudget(listSessions(user, { offset: 0 }), LIST_BUDGET_MS)
      .then((r): Listed => {
        syncConversationTitles(user.id, r.sessions);
        if (r.unavailable.length) return { sessions: r.sessions, unavailable: r.unavailable, updating: false, cachedAt: null };
        writeIndex(user.id, r.sessions, r.nextOffset === null);
        if (r.nextOffset !== null) void refresh(user);
        return { sessions: r.sessions, unavailable: [], updating: r.nextOffset !== null, cachedAt: new Date().toISOString() };
      })
      .catch((e): Listed => {
        noteIndexFailure(user.id, errKind(e));
        // A failing assistant backend is reported, never shown as "no conversations".
        return { sessions: [], unavailable: ["Hermes"], updating: false, cachedAt: null };
      })
      .finally(() => firstPages.delete(user.id));
    firstPages.set(user.id, p);
  }
  return p;
}

async function sessionsFor(user: CurrentUser, opts: { revalidate?: boolean } = {}): Promise<Listed> {
  const now = Date.now();
  const hit = readIndex(user.id);
  if (!hit?.refreshedAt) {
    // Never listed (or never successfully): the progressive first page.
    if (hit?.attemptedAt && now - hit.attemptedAt < RETRY_AFTER_FAILURE_MS && !opts.revalidate) {
      return { sessions: listLocalConversations(user), unavailable: ["Hermes"], updating: false, cachedAt: null };
    }
    const r = await firstPage(user);
    if (!r.unavailable.length) return r;
    // Claude-only partial or failure: whatever there is, flagged.
    return r.sessions.length ? r : { ...r, sessions: listLocalConversations(user) };
  }
  touchIndex(user.id);
  const age = now - hit.refreshedAt;
  if (age < STALE_OK_MS) {
    if (opts.revalidate || age >= FRESH_MS || !hit.complete) void refresh(user);
    return fromIndex(user, hit, []);
  }
  // Older than STALE_OK_MS (Hermes has been failing): try once within the budget,
  // unless that just failed; then the cached list, flagged as possibly incomplete.
  const recentFailure = hit.attemptedAt !== null && hit.attemptedAt > hit.refreshedAt && now - hit.attemptedAt < RETRY_AFTER_FAILURE_MS;
  if (recentFailure && !opts.revalidate) {
    return fromIndex(user, hit, ["Hermes"]);
  }
  const ok = await refresh(user);
  const latest = readIndex(user.id) ?? hit;
  return fromIndex(user, latest, ok ? [] : ["Hermes"]);
}

/**
 * Keep recently used indexes fresh (the dispatcher tick calls this every
 * ~30 s; each index is refreshed at most every WARM_EVERY_MS). Starts the
 * refreshes in the background, one at a time, and returns how many it queued.
 */
export function warmConversationIndexes(now = new Date()): number {
  const due = recentIndexUsers(new Date(now.getTime() - WARM_IDLE_MS)).filter(
    (r) => !refreshing.has(r.userId) && now.getTime() - Math.max(r.refreshedAt ?? 0, r.attemptedAt ?? 0) >= WARM_EVERY_MS,
  );
  const users = due.map((r) => userById(r.userId)).filter((u): u is CurrentUser => !!u && u.capabilities.has("hermes.chat"));
  if (!users.length) return 0;
  const [first, ...rest] = users;
  const chain = rest.reduce<Promise<unknown>>((c, u) => c.then(() => refresh(u)), refresh(first!));
  warming.add(chain);
  void chain.finally(() => warming.delete(chain));
  return users.length;
}

function sortRecent(list: SessionSummary[]) {
  return list.sort((a, b) => (b.lastActiveAt ?? b.startedAt ?? "").localeCompare(a.lastActiveAt ?? a.startedAt ?? ""));
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
export async function listConversations(user: CurrentUser, q?: string | null, opts: { revalidate?: boolean } = {}): Promise<ConversationsResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable, updating, cachedAt } = await sessionsFor(user, opts);
  const ctx = context(user.id);
  const needle = q?.trim().toLowerCase();
  const conversations = sessions
    .filter((s) => !s.archived)
    .map((s) => toOption(s, ctx))
    .filter((c) => !needle || `${c.title} ${c.preview ?? ""}`.toLowerCase().includes(needle))
    .slice(0, 50);
  return { conversations, unavailable, updating, cachedAt };
}

/** The conversations view of the Areas tree: All or Unfiled (not in the tree, or only in Miscellaneous), with filing suggestions. */
export async function conversationList(
  user: CurrentUser,
  filter: ConversationFilter,
  q?: string | null,
  opts: { revalidate?: boolean } = {},
): Promise<ConversationListResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable, updating, cachedAt } = await sessionsFor(user, opts);
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
  return { conversations, unfiledCount, unavailable, updating, cachedAt };
}

/** Recent conversations of yours that aren't in the tree at all (not dismissed), with filing suggestions: the Inbox's list. */
export async function unfiledConversations(user: CurrentUser, opts: { revalidate?: boolean } = {}): Promise<UnfiledResponse> {
  requireCap(user, "hermes.chat");
  const { sessions, unavailable, updating, cachedAt } = await sessionsFor(user, opts);
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
    updating,
    cachedAt,
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
    const session = await withBudget(getSessionSummary(user, body.sessionId), DETAIL_BUDGET_MS);
    if (session.readOnly) throw new HttpError(403, "read_only", "Fork a shared conversation to file it");
    title = session.title || title;
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
