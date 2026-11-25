import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import { requireCap, type Capable } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { processSingleton } from "@/server/singleton";
import { startConversation } from "@/server/areas";
import { createSession } from "@/server/assistant";
import type { AssistantBackend } from "@/lib/assistant";
import { canHaveChat } from "@/lib/task-chat";
import type { WorkItem, WorkKind, WorkLink } from "@/lib/work";
import { conversationNodes, event, latestPacket, ownedItem, placeConversation, primaryChatTask, recordOp, toItem, toLink, type OpOut } from "./store";

/**
 * A task's primary chat (task threads, step 1; lib/task-chat.ts). One stored pointer, `work_items.primary_session_id`,
 * that every reader of "the task's chat" uses. The chat is created the first time there is a message to put in it,
 * as a conversation filed under the task on the profile that answers for the task's area. A chat is primary for one
 * task at most, and a chat that served several tasks is never promoted.
 */

type Viewer = CurrentUser & Capable;
const T = schema.workItems;
const nowIso = () => new Date().toISOString();

const asTask = (row: { kind: string; parentId: string | null }) => canHaveChat({ kind: row.kind as WorkKind, parentId: row.parentId });

/**
 * Whether this chat also served another item: it is another task's primary chat, it is filed under another item
 * (Miscellaneous counts as not filed), another item links it, or an agent run on another item names it.
 */
export function chatServesOthers(userId: string, sessionId: string, itemId: string): boolean {
  const db = getDb();
  const other = primaryChatTask(userId, sessionId);
  if (other && other.id !== itemId) return true;
  const node = conversationNodes(userId).get(sessionId);
  if (node?.parentId && node.parentId !== itemId) {
    const parent = db.select({ systemKey: T.systemKey }).from(T).where(eq(T.id, node.parentId)).get();
    if (!parent?.systemKey) return true;
  }
  const linked = db
    .select({ itemId: schema.workLinks.itemId })
    .from(schema.workLinks)
    .innerJoin(T, eq(T.id, schema.workLinks.itemId))
    .where(and(eq(T.userId, userId), eq(schema.workLinks.kind, "chat_session"), eq(schema.workLinks.targetId, sessionId), ne(schema.workLinks.itemId, itemId)))
    .get();
  if (linked) return true;
  const ran = db
    .select({ itemId: schema.agentRuns.itemId })
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.userId, userId), eq(schema.agentRuns.hermesSessionId, sessionId), ne(schema.agentRuns.itemId, itemId)))
    .get();
  return !!ran;
}

/**
 * "Make primary": one of the task's other chats becomes its primary chat (undoable). The chat must already be the
 * task's (filed under it or linked to it) and must not have served another item. A linked chat is filed under the
 * task as part of this, so the primary is always a conversation under its task.
 */
export function setPrimaryChat(user: CurrentUser, itemId: string, sessionId: string, correlationId: string, out?: OpOut): WorkItem {
  const row = ownedItem(user.id, itemId);
  if (!asTask(row)) throw new HttpError(409, "no_chat", "Only a task has a primary chat");
  const node = conversationNodes(user.id).get(sessionId);
  const filedHere = !!node && node.parentId === itemId && !node.archived;
  const link = getDb()
    .select()
    .from(schema.workLinks)
    .where(and(eq(schema.workLinks.itemId, itemId), eq(schema.workLinks.kind, "chat_session"), eq(schema.workLinks.targetId, sessionId)))
    .get();
  if (!filedHere && !link) throw new HttpError(404, "not_found", "That chat isn't one of this task's chats");
  if (chatServesOthers(user.id, sessionId, itemId))
    throw new HttpError(409, "chat_shared", "That chat also served other work, so it can't be one task's primary chat");
  const title = node?.title || link?.title || "Chat";
  if (!filedHere) placeConversation(user, { sessionId, parentId: itemId, title }, correlationId);
  getDb().transaction((tx) => {
    const now = ownedItem(user.id, itemId, tx);
    const prev = now.primarySessionId ?? null;
    if (prev === sessionId) return;
    tx.update(T).set({ primarySessionId: sessionId, updatedAt: nowIso() }).where(eq(T.id, itemId)).run();
    event(tx, itemId, user.id, { kind: "chat", reason: `Primary chat: “${title}”` });
    recordOp(tx, user.id, itemId, "primary_chat", { prev, next: sessionId }, out);
  });
  audit({ actor: user.id, action: "work.primary_chat", source: "work", sourceRecord: itemId, result: "ok", correlationId, detail: { session: sessionId } });
  return toItem(ownedItem(user.id, itemId));
}

type Ensured = { sessionId: string; created: boolean };
/** One creation per task at a time: two sends racing for a task's first message must end in one chat. */
const creating = () => processSingleton<Map<string, Promise<Ensured>>>("task_chat_create", () => new Map());

/**
 * The task's primary chat, created now if it has none: a conversation filed under the task, on the profile that
 * answers for its area, recorded as primary. Called when there is a first message to send (never on page load).
 */
export async function ensureTaskChat(
  user: Viewer,
  itemId: string,
  backend: AssistantBackend | undefined,
  correlationId: string,
  /** `profile`: the agent that works on the task (a bot started it); left out, the one that answers for its area. */
  opts: { profile?: string | null } = {},
): Promise<Ensured> {
  requireCap(user, "hermes.chat");
  const row = ownedItem(user.id, itemId);
  if (!asTask(row)) throw new HttpError(409, "no_chat", "Only a task has a chat of its own");
  if (row.archived) throw new HttpError(409, "archived", "Unarchive this task before chatting in it");
  if (row.primarySessionId) return { sessionId: row.primarySessionId, created: false };
  const key = `${user.id}:${itemId}`;
  const inFlight = creating().get(key);
  if (inFlight) return inFlight;
  const made = (async (): Promise<Ensured> => {
    const session =
      opts.profile === undefined
        ? await startConversation(user, { title: row.title.slice(0, 200), backend, areaId: itemId }, correlationId)
        : { ...(await createSession(user, row.title.slice(0, 200), "hermes", opts.profile)), placedIn: null };
    // startConversation files best-effort; the primary chat must be filed under its task.
    if (session.placedIn !== itemId) placeConversation(user, { sessionId: session.id, parentId: itemId, title: session.title || row.title }, correlationId);
    const sessionId = getDb().transaction((tx) => {
      const now = ownedItem(user.id, itemId, tx);
      if (now.primarySessionId) return now.primarySessionId;
      tx.update(T).set({ primarySessionId: session.id, updatedAt: nowIso() }).where(eq(T.id, itemId)).run();
      event(tx, itemId, user.id, { kind: "chat", reason: "Chat started" });
      return session.id;
    });
    audit({ actor: user.id, action: "work.chat_start", source: "work", sourceRecord: itemId, result: "ok", correlationId, detail: { session: sessionId } });
    return { sessionId, created: sessionId === session.id };
  })().finally(() => creating().delete(key));
  creating().set(key, made);
  return made;
}

/**
 * A hand-off to another agent: a new conversation on that agent's profile, filed under the task, becomes its
 * primary chat. The one it had stays under Other chats (a conversation stays on the profile it was created on).
 */
export async function replaceTaskChat(
  user: Viewer,
  itemId: string,
  profile: string | null,
  correlationId: string,
): Promise<{ sessionId: string; prev: string | null }> {
  requireCap(user, "hermes.chat");
  const row = ownedItem(user.id, itemId);
  if (!asTask(row)) throw new HttpError(409, "no_chat", "Only a task has a chat of its own");
  const session = await createSession(user, row.title.slice(0, 200), "hermes", profile);
  placeConversation(user, { sessionId: session.id, parentId: itemId, title: session.title || row.title }, correlationId);
  const prev = getDb().transaction((tx) => {
    const now = ownedItem(user.id, itemId, tx);
    tx.update(T).set({ primarySessionId: session.id, updatedAt: nowIso() }).where(eq(T.id, itemId)).run();
    event(tx, itemId, user.id, { kind: "chat", reason: profile ? `Chat with @${profile} started` : "Chat started" });
    return now.primarySessionId ?? null;
  });
  audit({
    actor: user.id,
    action: "work.chat_start",
    source: "work",
    sourceRecord: itemId,
    result: "ok",
    correlationId,
    detail: { session: session.id, replaced: prev },
  });
  return { sessionId: session.id, prev };
}

/**
 * Hand a work packet to the item's chat. A task continues in its own primary chat (created here when it has none);
 * an area gets a new conversation filed under it. The conversation runs on the profile that answers for the area.
 * The handoff itself is only a draft in the browser: nothing is sent to the assistant here.
 */
export async function continueInConversation(user: Viewer, itemId: string, backend: AssistantBackend | undefined, correlationId: string) {
  requireCap(user, "hermes.chat");
  const row = ownedItem(user.id, itemId);
  const packet = latestPacket(itemId);
  const via = packet ? `handoff from packet v${packet.version}` : "handoff, no packet yet";
  let sessionId: string;
  let title = `Continue: ${row.title}`.slice(0, 200);
  let created = true;
  if (asTask(row)) {
    const chat = await ensureTaskChat(user, itemId, backend, correlationId);
    sessionId = chat.sessionId;
    created = chat.created;
    title = conversationNodes(user.id).get(sessionId)?.title || row.title;
  } else {
    const session = await startConversation(user, { title, backend, areaId: itemId }, correlationId);
    sessionId = session.id;
    title = session.title || title;
  }
  const linkId = created ? newId() : null;
  getDb().transaction((tx) => {
    if (linkId)
      tx.insert(schema.workLinks)
        .values({
          id: linkId,
          itemId,
          kind: "chat_session",
          targetId: sessionId,
          url: null,
          title,
          role: "source",
          lineage: "handoff_from",
          packetId: packet?.id ?? null,
          createdAt: nowIso(),
        })
        .run();
    event(tx, itemId, user.id, { kind: "handoff", reason: created ? `Continued in a new conversation (${via})` : `Continued in its chat (${via})` });
  });
  audit({
    actor: user.id,
    action: "work.handoff",
    source: "work",
    sourceRecord: itemId,
    result: "ok",
    correlationId,
    detail: { session: sessionId, packet: packet?.version ?? null, created },
  });
  const link: WorkLink | null = linkId ? toLink(getDb().select().from(schema.workLinks).where(eq(schema.workLinks.id, linkId)).get()!) : null;
  return { session: { id: sessionId, title }, link, created };
}
