import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { MapEdge, MapGraph, MapRelation } from "@/lib/work-map";
import type { WorkKind, WorkStatus } from "@/lib/work";
import { ensureMiscellaneous, subtree } from "./store";

/** The map draws at most this many items (the accessible list says when it's cut). */
export const MAP_MAX_NODES = 300;
const LINEAGE: MapRelation[] = ["forked_from", "split_from", "handoff_from"];

/**
 * Read-only graph of an area/project (or everything): tree edges, lineage
 * edges (fork/split/handoff; moves are placement history, not relations) and
 * dependencies, limited to the visible, unarchived items in view.
 */
export function mapGraph(userId: string, rootId: string | null): MapGraph {
  ensureMiscellaneous(userId);
  const tree = subtree(userId, rootId);
  const shown = tree.slice(0, MAP_MAX_NODES);
  const ids = new Set(shown.map((t) => t.row.id));
  const edges: MapEdge[] = [];
  for (const { row } of shown) if (row.parentId && ids.has(row.parentId)) edges.push({ id: `t:${row.id}`, from: row.parentId, to: row.id, relation: "tree" });
  const db = getDb();
  for (const l of db.select().from(schema.workLineage).where(eq(schema.workLineage.userId, userId)).all()) {
    const rel = l.relation as MapRelation;
    if (!LINEAGE.includes(rel) || !l.parentId || !ids.has(l.parentId) || !ids.has(l.childId)) continue;
    edges.push({ id: `l:${l.id}`, from: l.parentId, to: l.childId, relation: rel });
  }
  for (const d of db.select().from(schema.workDependencies).where(eq(schema.workDependencies.userId, userId)).all())
    if (ids.has(d.itemId) && ids.has(d.dependsOnId)) edges.push({ id: `d:${d.id}`, from: d.dependsOnId, to: d.itemId, relation: "depends_on" });
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const roots = subtree(userId, null)
    .map((t) => t.row)
    .filter((r) => r.kind === "area" || r.kind === "project")
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind as WorkKind }));
  const root = rootId ? shown[0]?.row : null;
  return {
    root: root ? { id: root.id, title: root.title } : null,
    roots,
    nodes: shown.map(({ row }) => ({
      id: row.id,
      title: row.title,
      kind: row.kind as WorkKind,
      status: row.status as WorkStatus,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
    })),
    edges,
    truncated: tree.length > shown.length,
  };
}
