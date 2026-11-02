import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSetting } from "@/server/settings";
import { HttpError } from "@/server/http/errors";
import { newId } from "@/server/crypto";
import { TAG_OPS_ITEM } from "./undo-rules";
import { agentSettingsSchema, DEFAULT_AGENT_SETTINGS } from "@/lib/agents";
import { BUILTIN_AGENTS, defaultTagColor, isTagColor, normaliseTag, parseTags, serialiseTags, type TagColor, type WorkTag } from "@/lib/item-tags";

/**
 * Tag registry and assignee directory (#111). Tags live on work_items.tags (JSON);
 * work_tags keeps their colour and lets Settings rename/merge them.
 */

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0] | ReturnType<typeof getDb>;
const T = schema.workItems;
const G = schema.workTags;

/** Agents that can be assigned: the coordinator profiles + every configured route. */
export function knownAgents(): string[] {
  const raw = getSetting<unknown>("agents");
  const parsed = agentSettingsSchema.safeParse({ ...DEFAULT_AGENT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) });
  const routes = parsed.success ? parsed.data.routes.map((r) => r.profile) : [];
  return [...new Set<string>([...BUILTIN_AGENTS, ...routes])].sort();
}

/** People that can be assigned: active (not disabled) users. */
export function knownPeople(db: Tx = getDb()): { id: string; name: string }[] {
  return db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(isNull(schema.users.disabledAt)).all();
}

export function assigneeDirectory() {
  return {
    agents: knownAgents().map((id) => ({ id, ref: `agent:${id}`, label: `@${id}` })),
    people: knownPeople().map((p) => ({ ...p, ref: `person:${p.id}`, label: p.name })),
  };
}

/** Registers tags that don't exist yet (default colour by name). */
export function ensureTags(tx: Tx, userId: string, names: readonly string[]) {
  for (const name of names)
    tx.insert(G)
      .values({ userId, name, color: defaultTagColor(name) })
      .onConflictDoNothing()
      .run();
}

export function listTags(userId: string): WorkTag[] {
  const db = getDb();
  const counts = new Map<string, number>();
  for (const r of db
    .select({ tags: T.tags })
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.archived, false)))
    .all())
    for (const t of parseTags(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const rows = db.select().from(G).where(eq(G.userId, userId)).all();
  const out = new Map<string, WorkTag>();
  for (const r of rows) out.set(r.name, { name: r.name, color: isTagColor(r.color) ? r.color : defaultTagColor(r.name), count: counts.get(r.name) ?? 0 });
  // Items imported with tags the registry hasn't seen still show (default colour).
  for (const [name, count] of counts) if (!out.has(name)) out.set(name, { name, color: defaultTagColor(name), count });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function setTagColor(userId: string, rawName: string, color: TagColor) {
  const name = normaliseTag(rawName);
  if (!name) throw new HttpError(400, "tag", "Type a tag name");
  getDb()
    .insert(G)
    .values({ userId, name, color })
    .onConflictDoUpdate({ target: [G.userId, G.name], set: { color } })
    .run();
}

type TagRow = { name: string; color: string; createdAt: string };
export type TagRenamePayload = {
  from: string;
  to: string;
  merged: boolean;
  /** every touched item: tags before and after the rename */
  items: { id: string; prev: string[]; next: string[] }[];
  /** the registry rows before the rename (null = didn't exist) */
  fromRow: TagRow | null;
  toRow: TagRow | null;
};

/**
 * Renames a tag on every item; renaming onto an existing tag merges them
 * (items keep one copy, the target keeps its colour). Returns items touched and an
 * undoable op (#154) that snapshots each item's previous tags and both tag rows.
 */
export function renameTag(
  userId: string,
  rawFrom: string,
  rawTo: string,
): { touched: number; merged: boolean; op?: { id: string; kind: "tag_rename"; label: string } } {
  const from = normaliseTag(rawFrom);
  const to = normaliseTag(rawTo);
  if (!from || !to) throw new HttpError(400, "tag", "Type a tag name");
  if (from === to) return { touched: 0, merged: false };
  return getDb().transaction((tx) => {
    const row = (name: string) =>
      tx
        .select()
        .from(G)
        .where(and(eq(G.userId, userId), eq(G.name, name)))
        .get();
    const target = row(to);
    const source = row(from);
    let merged = !!target;
    const items: TagRenamePayload["items"] = [];
    for (const r of tx.select({ id: T.id, tags: T.tags }).from(T).where(eq(T.userId, userId)).all()) {
      const tags = parseTags(r.tags);
      if (!tags.includes(from)) continue;
      if (tags.includes(to)) merged = true;
      const next = [...new Set(tags.map((t) => (t === from ? to : t)))].sort();
      tx.update(T)
        .set({ tags: serialiseTags(next) })
        .where(eq(T.id, r.id))
        .run();
      items.push({ id: r.id, prev: tags, next });
    }
    if (!target)
      tx.insert(G)
        .values({ userId, name: to, color: source?.color ?? defaultTagColor(to) })
        .onConflictDoNothing()
        .run();
    tx.delete(G)
      .where(and(eq(G.userId, userId), inArray(G.name, [from])))
      .run();
    const snap = (r: typeof source): TagRow | null => (r ? { name: r.name, color: r.color, createdAt: r.createdAt } : null);
    const payload: TagRenamePayload = { from, to, merged, items, fromRow: snap(source), toRow: snap(target) };
    const id = newId("op");
    tx.insert(schema.workOps)
      .values({ id, userId, itemId: TAG_OPS_ITEM, kind: "tag_rename", payload: JSON.stringify(payload), createdAt: new Date().toISOString() })
      .run();
    const label = merged ? `Merged #${from} into #${to}` : `Renamed #${from} → #${to}`;
    return { touched: items.length, merged, op: { id, kind: "tag_rename" as const, label } };
  });
}

/**
 * Undo a rename/merge (#154): every touched item gets its previous tags back and the tag rows
 * (with their colours) are restored. Refuses if any touched item's tags changed since.
 */
export function undoTagRename(tx: Tx, userId: string, p: TagRenamePayload) {
  const ids = p.items.map((i) => i.id);
  const cur = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500)
    for (const r of tx
      .select({ id: T.id, tags: T.tags })
      .from(T)
      .where(and(eq(T.userId, userId), inArray(T.id, ids.slice(i, i + 500))))
      .all())
      cur.set(r.id, r.tags);
  for (const it of p.items) {
    const now = cur.get(it.id);
    if (now === undefined) continue; // item deleted since: nothing to restore
    if (JSON.stringify(parseTags(now)) !== JSON.stringify(it.next))
      throw new HttpError(409, "superseded", "Some of these items' tags changed since, so undo isn't safe");
  }
  for (const it of p.items)
    if (cur.has(it.id))
      tx.update(T)
        .set({ tags: serialiseTags(it.prev) })
        .where(eq(T.id, it.id))
        .run();
  const put = (r: TagRow) =>
    tx
      .insert(G)
      .values({ userId, name: r.name, color: r.color, createdAt: r.createdAt })
      .onConflictDoUpdate({ target: [G.userId, G.name], set: { color: r.color } })
      .run();
  if (p.fromRow) put(p.fromRow);
  else
    tx.insert(G)
      .values({ userId, name: p.from, color: defaultTagColor(p.from) })
      .onConflictDoNothing()
      .run();
  if (p.toRow) put(p.toRow);
  else
    tx.delete(G)
      .where(and(eq(G.userId, userId), eq(G.name, p.to)))
      .run();
}
