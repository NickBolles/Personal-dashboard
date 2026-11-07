import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import { parseTags, serialiseTags } from "@/lib/item-tags";
import { serialiseDecision } from "@/lib/decisions";
import { planPortfolioImport, type ImportPlan, type PlanLink, type PortfolioMap } from "@/lib/portfolio-import";
import { event, insertItem, recordOp, type OpOut } from "./store";
import { ensureTags } from "./tags";
import { IMPORT_OPS_ITEM } from "./undo-rules";
import type { PortfolioImportPayload } from "./portfolio-undo";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The owner's tree as the planner sees it. */
function existing(userId: string) {
  const db = getDb();
  const T = schema.workItems;
  const rows = db
    .select({ id: T.id, parentId: T.parentId, kind: T.kind, title: T.title, archived: T.archived, tags: T.tags, systemKey: T.systemKey })
    .from(T)
    .where(eq(T.userId, userId))
    .all();
  const ids = rows.map((r) => r.id);
  const links = ids.length
    ? db.select({ itemId: schema.workLinks.itemId, url: schema.workLinks.url }).from(schema.workLinks).where(inArray(schema.workLinks.itemId, ids)).all()
    : [];
  return { items: rows.map((r) => ({ ...r, tags: parseTags(r.tags) })), links };
}

function insertLink(tx: Tx, userId: string, itemId: string, l: PlanLink): string {
  const id = newId();
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)$/.exec(l.url);
  const at = new Date().toISOString();
  tx.insert(schema.workLinks)
    .values({
      id,
      itemId,
      kind: l.kind,
      targetId: gh ? `${gh[1]}/${gh[2]}#${gh[3]}` : null,
      url: l.url,
      title: l.title,
      role: l.kind === "github_pr" ? "implementation" : "reference",
      // GitHub state is read back later (never fetched here); "open" is the same default Link PR uses.
      ...(gh ? { externalState: "open", stateChangedAt: at } : {}),
      createdAt: at,
    })
    .run();
  event(tx, itemId, userId, { kind: "link", reason: `Linked ${l.title}` });
  return id;
}

export type PortfolioImportResult = {
  plan: ImportPlan;
  applied: { created: number; updated: number; links: number } | null;
  op?: OpOut["op"];
};

/**
 * Dry run (default) or apply a portfolio map import. Applying is one
 * transaction with one Undo (work_ops kind "import"); it only adds items,
 * links and tags, never deletes, moves, renames, re-statuses or settles.
 */
export function importPortfolioMap(
  user: CurrentUser,
  map: PortfolioMap,
  opts: { apply?: boolean; aliases?: Record<string, string> },
  correlationId: string,
): PortfolioImportResult {
  const plan = planPortfolioImport(map, existing(user.id), { aliases: opts.aliases });
  if (!opts.apply) return { plan, applied: null };
  if (!plan.counts.create && !plan.counts.update) return { plan, applied: { created: 0, updated: 0, links: 0 } };
  const out: OpOut = {};
  const payload: PortfolioImportPayload = { items: [], links: [], tags: [] };
  let updated = 0;
  getDb().transaction((tx) => {
    const T = schema.workItems;
    const keyIds = new Map<string, string>();
    for (const e of plan.entries) {
      if (e.action === "create") {
        const parentId = e.parentId ?? (e.parentKey ? keyIds.get(e.parentKey) : undefined);
        if (!parentId) continue;
        const id = insertItem(tx, user.id, { parentId, kind: e.kind, title: e.title, summary: e.summary, nextAction: e.nextAction, status: e.status });
        const row = tx.select({ createdAt: T.createdAt }).from(T).where(eq(T.id, id)).get()!;
        ensureTags(tx, user.id, e.tags);
        // Same stamp as createdAt: the item still reads as untouched for Undo.
        tx.update(T)
          .set({
            tags: serialiseTags(e.tags),
            ...(e.decision ? { decision: serialiseDecision(e.decision, row.createdAt) } : {}),
            updatedAt: row.createdAt,
          })
          .where(eq(T.id, id))
          .run();
        event(tx, id, user.id, { kind: "created", to: e.status ?? "captured", reason: "Imported from the portfolio map" });
        keyIds.set(e.key, id);
        payload.items.push(id);
        for (const l of e.links) payload.links.push(insertLink(tx, user.id, id, l));
      } else if (e.action === "update" && e.matchedId) {
        for (const l of e.links) payload.links.push(insertLink(tx, user.id, e.matchedId, l));
        if (e.tags.length) {
          const row = tx.select({ tags: T.tags }).from(T).where(eq(T.id, e.matchedId)).get();
          if (row) {
            const prev = parseTags(row.tags);
            const next = [...prev, ...e.tags.filter((t) => !prev.includes(t))].slice(0, 12);
            ensureTags(tx, user.id, next);
            tx.update(T)
              .set({ tags: serialiseTags(next), updatedAt: new Date().toISOString() })
              .where(eq(T.id, e.matchedId))
              .run();
            event(tx, e.matchedId, user.id, { kind: "edit", reason: `Portfolio map import: tagged ${e.tags.join(", ")}` });
            payload.tags.push({ id: e.matchedId, prev, next });
          }
        }
        updated++;
      }
    }
    recordOp(tx, user.id, IMPORT_OPS_ITEM, "import", payload, out);
  });
  audit({
    actor: user.id,
    action: "work.import_portfolio",
    source: "work",
    sourceRecord: IMPORT_OPS_ITEM,
    result: "ok",
    correlationId,
    detail: { created: payload.items.length, updated, links: payload.links.length },
  });
  return { plan, applied: { created: payload.items.length, updated, links: payload.links.length }, op: out.op };
}
