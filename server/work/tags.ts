import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSetting } from "@/server/settings";
import { HttpError } from "@/server/http/errors";
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

/**
 * Renames a tag on every item; renaming onto an existing tag merges them
 * (items keep one copy, the target keeps its colour). Returns items touched.
 */
export function renameTag(userId: string, rawFrom: string, rawTo: string): { touched: number; merged: boolean } {
  const from = normaliseTag(rawFrom);
  const to = normaliseTag(rawTo);
  if (!from || !to) throw new HttpError(400, "tag", "Type a tag name");
  if (from === to) return { touched: 0, merged: false };
  return getDb().transaction((tx) => {
    const target = tx
      .select()
      .from(G)
      .where(and(eq(G.userId, userId), eq(G.name, to)))
      .get();
    const source = tx
      .select()
      .from(G)
      .where(and(eq(G.userId, userId), eq(G.name, from)))
      .get();
    let touched = 0;
    let merged = !!target;
    for (const r of tx.select({ id: T.id, tags: T.tags }).from(T).where(eq(T.userId, userId)).all()) {
      const tags = parseTags(r.tags);
      if (!tags.includes(from)) continue;
      if (tags.includes(to)) merged = true;
      const next = [...new Set(tags.map((t) => (t === from ? to : t)))].sort();
      tx.update(T)
        .set({ tags: serialiseTags(next) })
        .where(eq(T.id, r.id))
        .run();
      touched++;
    }
    if (!target)
      tx.insert(G)
        .values({ userId, name: to, color: source?.color ?? defaultTagColor(to) })
        .onConflictDoNothing()
        .run();
    tx.delete(G)
      .where(and(eq(G.userId, userId), inArray(G.name, [from])))
      .run();
    return { touched, merged };
  });
}
