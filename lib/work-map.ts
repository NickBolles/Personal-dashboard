/**
 * Work map (P2, read-only orientation): graph types and a deterministic
 * layered tree layout. Client-safe and pure, so the page, the dashboard
 * snapshot widget and the unit tests share it. docs/work.md.
 */
import type { WorkKind, WorkStatus } from "./work";

export const MAP_RELATIONS = ["tree", "forked_from", "split_from", "handoff_from", "depends_on"] as const;
export type MapRelation = (typeof MAP_RELATIONS)[number];
export const MAP_RELATION_LABELS: Record<MapRelation, string> = {
  tree: "Contains",
  forked_from: "Forked from",
  split_from: "Split from",
  handoff_from: "Follow-up of",
  depends_on: "Depends on",
};

export type MapGraphNode = { id: string; title: string; kind: WorkKind; status: WorkStatus; parentId: string | null; sortOrder: number };
/** `from` → `to`: tree parent → child, lineage source → derived item, blocker → waiting item. */
export type MapEdge = { id: string; from: string; to: string; relation: MapRelation };
export type MapGraph = {
  root: { id: string; title: string } | null;
  roots: { id: string; title: string; kind: WorkKind }[];
  nodes: MapGraphNode[];
  edges: MapEdge[];
  /** more items than the map draws */
  truncated: boolean;
};

export type MapLayout = { positions: Record<string, { x: number; y: number }>; width: number; height: number };
export const MAP_NODE = { w: 168, h: 44, gapX: 24, gapY: 56 };

const order = (a: MapGraphNode, b: MapGraphNode) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/**
 * Layered tree layout: depth is the row, leaves take consecutive columns in
 * depth-first order and a parent is centred over its children. Nodes whose
 * parent isn't in the set start their own tree. Only ids, parent links,
 * sort order and titles matter, so the same graph always gets the same
 * picture whatever order the nodes arrive in.
 */
export function layoutMap(nodes: MapGraphNode[], size = MAP_NODE): MapLayout {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string | null, MapGraphNode[]>();
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  for (const list of kids.values()) list.sort(order);
  const col = new Map<string, number>();
  const row = new Map<string, number>();
  let next = 0;
  let maxDepth = 0;
  const seen = new Set<string>();
  const place = (n: MapGraphNode, depth: number): number => {
    seen.add(n.id);
    row.set(n.id, depth);
    maxDepth = Math.max(maxDepth, depth);
    const children = (kids.get(n.id) ?? []).filter((c) => !seen.has(c.id));
    if (!children.length || depth > 60) {
      col.set(n.id, next++);
      return col.get(n.id)!;
    }
    const xs = children.map((c) => place(c, depth + 1));
    const x = (xs[0]! + xs.at(-1)!) / 2;
    col.set(n.id, x);
    return x;
  };
  for (const r of kids.get(null) ?? []) place(r, 0);
  const stepX = size.w + size.gapX;
  const stepY = size.h + size.gapY;
  const positions: MapLayout["positions"] = {};
  for (const n of nodes) {
    if (!col.has(n.id)) continue;
    positions[n.id] = { x: Math.round(col.get(n.id)! * stepX), y: row.get(n.id)! * stepY };
  }
  return {
    positions,
    width: Math.max(size.w, next * stepX - size.gapX),
    height: nodes.length ? (maxDepth + 1) * stepY - size.gapY : size.h,
  };
}

/** Keep nodes passing the status filter and edges of the chosen relations between kept nodes. */
export function filterMap(g: Pick<MapGraph, "nodes" | "edges">, relations: Set<MapRelation>, statusOk: (s: WorkStatus) => boolean) {
  const nodes = g.nodes.filter((n) => statusOk(n.status));
  const keep = new Set(nodes.map((n) => n.id));
  return { nodes, edges: g.edges.filter((e) => relations.has(e.relation) && keep.has(e.from) && keep.has(e.to)) };
}
