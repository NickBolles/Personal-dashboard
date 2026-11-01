import "server-only";
import type { CurrentUser } from "@/server/auth";
import { can, type Capable } from "@/server/access";
import { cachedSessions } from "@/server/work/conversations";
import { listItems } from "@/server/work/store";
import { getDb, schema } from "@/server/db";
import { inArray } from "drizzle-orm";
import type { WorkItem } from "@/lib/work";

/**
 * The fast in-memory search index behind the palette (server/search.ts) and
 * the composer's `@` picker (server/references.ts).
 *
 * Data size decides the design: a household has hundreds (at most a few
 * thousand) items and conversations, so a linear scan of rows already in
 * SQLite takes single-digit milliseconds. What made search slow was waiting
 * on upstreams per keystroke (Hermes' session list: ~9 s on prod, cut at the
 * provider timeout so every query took 2.5–4 s and never found a chat). Here
 * conversations come from the persisted conversation index plus the filed
 * conversation nodes of the Areas tree, never from a live upstream call, and
 * slow live providers (Home cards, devices) go through `memo`
 * (stale-while-revalidate).
 */

type Viewer = CurrentUser & Capable;

export type ChatEntry = {
  sessionId: string;
  title: string;
  /** Hermes' preview (recent message snippet), if any */
  preview?: string;
  archived: boolean;
  readOnly?: boolean;
  /** the Areas node it's filed under (kind "conversation") */
  itemId?: string;
  /** "Areas › Miscellaneous" */
  path?: string;
  lastActiveAt?: string;
  /** filed under a Finance area: navigation only, never offered or resolved as AI context */
  finance: boolean;
};

const FINANCE_AREA = /(^|[\s/:._-])(finance|finances|monarch|money|budget)([\s/:._-]|$)/i;

export function pathIndex(items: WorkItem[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const area = (id: string) => {
    let c = byId.get(id);
    for (let n = 0; c?.parentId && n < 100; n++) c = byId.get(c.parentId);
    return c && !c.parentId ? c : undefined;
  };
  return {
    byId,
    /** ancestors' titles, outermost first ("Areas › Miscellaneous") */
    path: (id: string) => {
      const parts: string[] = [];
      for (let c = byId.get(byId.get(id)?.parentId ?? ""); c && parts.length < 6; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title);
      return parts.join(" › ");
    },
    /** under an area named like Finance (or is one) */
    finance: (id: string) => FINANCE_AREA.test(area(id)?.title ?? ""),
  };
}

/** Is this Areas node (or its area) Finance? Such nodes never reach AI context. */
export function isFinanceItem(items: WorkItem[], id: string) {
  return pathIndex(items).finance(id);
}

/**
 * Every conversation the person can see: the cached Hermes list (access
 * re-checked) merged with conversation nodes filed in their Areas tree (which
 * exist even before the index has ever loaded). Most recent first.
 */
export function chatEntries(user: Viewer, items: WorkItem[] | null = null): ChatEntry[] {
  if (!can(user, "hermes.chat")) return [];
  const work = items ?? (can(user, "work.use") ? itemsFor(user.id) : []);
  const p = pathIndex(work);
  const filed = new Map<string, WorkItem>();
  for (const i of work) if (i.kind === "conversation" && i.sessionId && !filed.has(i.sessionId)) filed.set(i.sessionId, i);
  const out: ChatEntry[] = [];
  const seen = new Set<string>();
  for (const s of cachedSessions(user)) {
    const node = filed.get(s.id);
    seen.add(s.id);
    out.push({
      sessionId: s.id,
      title: s.title || node?.title || "Untitled conversation",
      preview: s.preview || undefined,
      archived: s.archived,
      readOnly: s.readOnly,
      itemId: node?.id,
      path: node ? p.path(node.id) : undefined,
      lastActiveAt: s.lastActiveAt ?? s.startedAt,
      finance: node ? p.finance(node.id) : false,
    });
  }
  // Filed nodes the cached list doesn't have yet (index cold, or a brand-new chat): your own tree, so visible.
  // Archiving a chat only updates session_meta (both backends) and drops it from those lists, so the
  // node's own flag isn't enough: take the session's archive state too, or archived chats come back.
  const missing = [...filed.keys()].filter((sid) => !seen.has(sid));
  const archivedSessions = archivedIds(missing);
  for (const sid of missing) {
    const node = filed.get(sid)!;
    out.push({
      sessionId: sid,
      title: node.title || "Untitled conversation",
      preview: node.summary || undefined,
      archived: node.archived || archivedSessions.has(sid),
      itemId: node.id,
      path: p.path(node.id),
      lastActiveAt: node.updatedAt,
      finance: p.finance(node.id),
    });
  }
  return out.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
}

/** Session ids among `ids` archived in session_meta (where Jarvis records archive for Hermes and Claude-direct chats). */
function archivedIds(ids: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500)
    for (const r of getDb()
      .select({ id: schema.sessionMeta.sessionId, archived: schema.sessionMeta.archived })
      .from(schema.sessionMeta)
      .where(inArray(schema.sessionMeta.sessionId, ids.slice(i, i + 500)))
      .all())
      if (r.archived) out.add(r.id);
  return out;
}

const burst = new Map<string, { at: number; items: WorkItem[] }>();
/**
 * listItems shared by the providers of one search (they run in the same tick):
 * cached for 50 ms only, so it never serves a tree older than a keystroke.
 */
export function itemsFor(userId: string): WorkItem[] {
  const hit = burst.get(userId);
  if (hit && Date.now() - hit.at < 50) return hit.items;
  const items = listItems(userId, { includeArchived: true });
  burst.set(userId, { at: Date.now(), items });
  if (burst.size > 50) burst.delete(burst.keys().next().value!);
  return items;
}

type Memo = { at: number; value: unknown; pending?: Promise<unknown> };
const g = globalThis as unknown as { __jarvisSearchMemo?: Map<string, Memo> };
const memos = (g.__jarvisSearchMemo ??= new Map());

/**
 * Stale-while-revalidate for slow live providers: a cached value (even stale)
 * answers at once and older-than-`ttlMs` ones refresh in the background; only
 * the very first call waits. Keys must include the user id.
 */
export function memo<T>(key: string, ttlMs: number, load: () => Promise<T> | T): Promise<T> {
  const hit = memos.get(key);
  const start = () => {
    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        memos.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        const cur = memos.get(key);
        if (cur?.pending === pending) delete cur.pending;
        if (cur && cur.value === undefined && !cur.pending) memos.delete(key);
      });
    memos.set(key, { ...(hit ?? { at: 0, value: undefined }), pending });
    return pending;
  };
  if (hit && hit.value !== undefined) {
    if (Date.now() - hit.at >= ttlMs && !hit.pending) void start().catch(() => undefined);
    return Promise.resolve(hit.value as T);
  }
  return (hit?.pending as Promise<T> | undefined) ?? start();
}

/** Tests. */
export function __resetSearchMemo() {
  memos.clear();
  burst.clear();
}
