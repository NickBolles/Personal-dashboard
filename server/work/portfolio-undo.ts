import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { currentVia } from "@/server/work/actor";
import { parseTags, serialiseTags } from "@/lib/item-tags";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** What a portfolio map import wrote (work_ops.payload of an "import" op). */
export type PortfolioImportPayload = {
  /** created items, in creation order (parents before children) */
  items: string[];
  /** every link the import added (on new and existing items) */
  links: string[];
  /** existing items whose tags it extended: the tags before and after */
  tags: { id: string; prev: string[]; next: string[] }[];
};

/** Events an import itself writes on a new item; anything else means the owner touched it since. */
const IMPORT_EVENTS = new Set(["created", "link"]);

/**
 * Undo a portfolio map import: remove its links, put extended tags back (only
 * where they are still exactly what the import set), and delete each new item
 * nobody has touched since (children first); touched ones are archived instead.
 * Never deletes anything the import didn't create.
 */
export function undoPortfolioImport(tx: Tx, userId: string, p: PortfolioImportPayload): { deleted: number; archived: number } {
  const T = schema.workItems;
  const L = schema.workLinks;
  const owned = (ids: string[]) =>
    ids.length
      ? new Set(
          tx
            .select({ id: T.id })
            .from(T)
            .where(and(eq(T.userId, userId), inArray(T.id, ids)))
            .all()
            .map((r) => r.id),
        )
      : new Set<string>();
  const linkRows = p.links.length ? tx.select({ id: L.id, itemId: L.itemId }).from(L).where(inArray(L.id, p.links)).all() : [];
  const linkOwners = owned([...new Set(linkRows.map((l) => l.itemId))]);
  const mine = linkRows.filter((l) => linkOwners.has(l.itemId)).map((l) => l.id);
  if (mine.length) tx.delete(L).where(inArray(L.id, mine)).run();

  const at = new Date().toISOString();
  for (const t of p.tags) {
    const row = tx
      .select({ tags: T.tags })
      .from(T)
      .where(and(eq(T.id, t.id), eq(T.userId, userId)))
      .get();
    if (!row || serialiseTags(parseTags(row.tags)) !== serialiseTags(t.next)) continue;
    tx.update(T)
      .set({ tags: serialiseTags(t.prev), updatedAt: at })
      .where(eq(T.id, t.id))
      .run();
    tx.insert(schema.workEvents)
      .values({ id: newId(), itemId: t.id, actor: userId, kind: "undo", reason: "Undid portfolio map import (tags)", via: currentVia(), at })
      .run();
  }

  let deleted = 0;
  let archived = 0;
  for (const id of [...p.items].reverse()) {
    const row = tx
      .select()
      .from(T)
      .where(and(eq(T.id, id), eq(T.userId, userId)))
      .get();
    if (!row) continue;
    const kinds = tx
      .select({ kind: schema.workEvents.kind })
      .from(schema.workEvents)
      .where(eq(schema.workEvents.itemId, id))
      .all()
      .map((e) => e.kind);
    const busy =
      row.updatedAt !== row.createdAt ||
      kinds.some((k) => !IMPORT_EVENTS.has(k)) ||
      tx.select({ id: T.id }).from(T).where(eq(T.parentId, id)).all().length > 0 ||
      tx.select({ id: L.id }).from(L).where(eq(L.itemId, id)).all().length > 0 ||
      tx.select({ id: schema.workPackets.id }).from(schema.workPackets).where(eq(schema.workPackets.itemId, id)).all().length > 0 ||
      tx.select({ id: schema.workValidations.id }).from(schema.workValidations).where(eq(schema.workValidations.itemId, id)).all().length > 0;
    if (busy) {
      tx.update(T).set({ archived: true, updatedAt: at }).where(eq(T.id, id)).run();
      tx.insert(schema.workEvents)
        .values({
          id: newId(),
          itemId: id,
          actor: userId,
          kind: "undo",
          reason: "Undid portfolio map import: archived because it had changed since",
          via: currentVia(),
          at,
        })
        .run();
      archived++;
      continue;
    }
    tx.delete(schema.workEvents).where(eq(schema.workEvents.itemId, id)).run();
    tx.delete(T).where(eq(T.id, id)).run();
    deleted++;
  }
  return { deleted, archived };
}
