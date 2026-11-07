import type { WorkKind, WorkStatus } from "./work";

export type RadialNodeIn = { id: string; title: string; status: WorkStatus; kind: WorkKind; parentId: string | null };
export type RadialRelation = { from: string; to: string; kind: "depends" | "followup" };
export type RadialOpts = {
  width: number;
  height: number;
  /** Phone: one ring, grandchildren collapsed into "+N". */
  compact?: boolean;
  maxPerRing?: number;
};
export type PlacedNode = RadialNodeIn & {
  ring: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  angle: number;
  /** Word-wrapped, at most three lines. */
  lines: string[];
  anchor: "start" | "middle" | "end";
  /** Hidden children, not descendants. */
  more: number;
  ghost?: boolean;
};
export type PlacedEdge = { from: string; to: string; kind: "contains" | "depends" | "followup"; path: string };

/** Preserve whole words unless a single word exceeds the line width. */
export function wrapLabel(s: string, max: number): string[] {
  const width = Math.max(1, Math.floor(max) || 1);
  const words = s.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 <= width) {
      line += ` ${word}`;
      continue;
    }
    if (line) lines.push(line);
    let offset = 0;
    while (word.length - offset > width) {
      lines.push(word.slice(offset, offset + width));
      offset += width;
    }
    line = word.slice(offset);
  }
  if (line) lines.push(line);
  return lines.length > 3 ? [lines[0], lines[1], `${lines[2]}…`] : lines;
}

const TAU = Math.PI * 2;

/**
 * Linear-time, stable radial tree. Callers remove archived/conversation nodes.
 * Dense outer wedges collapse excess children into their parent's +N badge.
 */
export function radialLayout(
  centreId: string | null,
  nodes: RadialNodeIn[],
  relations: RadialRelation[],
  opts: RadialOpts,
): {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  radius: { r1: number; r2: number };
} {
  const width = Math.max(1, opts.width);
  const height = Math.max(1, opts.height);
  const unit = Math.min(width, height);
  const radius = { r1: unit * (opts.compact ? 0.34 : 0.27), r2: unit * 0.44 };
  const cx = width / 2;
  const cy = height / 2;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, RadialNodeIn[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }
  const placed = new Map<string, PlacedNode>();
  const edges: PlacedEdge[] = [];
  const place = (node: RadialNodeIn, ring: PlacedNode["ring"], angle: number, r: number, more = 0, ghost = false) => {
    const cos = Math.cos(angle);
    const result: PlacedNode = {
      ...node,
      ring,
      angle,
      x: cx + cos * r,
      y: cy + Math.sin(angle) * r,
      more,
      lines: wrapLabel(node.title, opts.compact ? 12 : ring === 2 || ring === 3 ? 14 : 16),
      anchor: ring === 0 ? "middle" : cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle",
      ...(ghost ? { ghost: true } : {}),
    };
    placed.set(node.id, result);
    return result;
  };
  const contains = (a: PlacedNode, b: PlacedNode) => edges.push({ from: a.id, to: b.id, kind: "contains", path: `M ${a.x} ${a.y} L ${b.x} ${b.y}` });
  const root = centreId === null ? { id: "__all", title: "All areas", status: "captured" as const, kind: "area" as const, parentId: null } : byId.get(centreId);
  if (!root) return { nodes: [], edges, radius };
  const centre = place(root, 0, -Math.PI / 2, 0);
  const allChildren = (children.get(centreId) ?? []).filter((n) => n.id !== root.id && (centreId !== null || n.kind === "area"));
  const limit = Math.max(1, Math.floor(opts.maxPerRing ?? (opts.compact ? 8 : 12)));
  const overflow = allChildren.length > limit;
  const first = allChildren.slice(0, overflow ? limit - 1 : limit);
  if (overflow)
    first.push({ id: `__more:${root.id}`, title: `+${allChildren.length - first.length} more`, status: root.status, kind: "note", parentId: root.id });
  const wedge = TAU / Math.max(1, first.length);
  first.forEach((node, i) => {
    const angle = -Math.PI / 2 + i * wedge;
    const grandchildren = (children.get(node.id) ?? []).filter((n) => n.id !== root.id && !placed.has(n.id));
    const parent = place(node, 1, angle, radius.r1, opts.compact ? grandchildren.length : 0);
    contains(centre, parent);
    if (opts.compact) return;
    // Keep 24px between outer dots and a margin on both sides of the wedge.
    const minAngle = 2 * Math.asin(Math.min(1, 12 / radius.r2));
    const available = Math.min(wedge * 0.8, TAU * 0.8);
    const capacity = Math.max(1, Math.floor(available / minAngle) + 1);
    const visible = grandchildren.slice(0, capacity);
    parent.more = grandchildren.length - visible.length;
    const spread = Math.min(available, Math.max(0, visible.length - 1) * minAngle);
    visible.forEach((child, j) => {
      const childAngle = angle + (visible.length > 1 ? (j / (visible.length - 1) - 0.5) * spread : 0);
      contains(parent, place(child, 2, childAngle, radius.r2));
    });
  });
  // Ghosts may connect to the tree, but must not recursively expand relations.
  const treeIds = new Set(placed.keys());
  let ghosts = 0;
  for (const relation of relations) {
    const fromTree = treeIds.has(relation.from);
    const toTree = treeIds.has(relation.to);
    if (!fromTree && !toTree) continue;
    const outsideId = !fromTree ? relation.from : !toTree ? relation.to : null;
    if (outsideId && !placed.has(outsideId)) {
      if (ghosts >= 6) continue;
      // Partial item snapshots still expose the relation, using its id as a label.
      const outside = byId.get(outsideId) ?? { id: outsideId, title: outsideId, status: "captured" as const, kind: "thread" as const, parentId: null };
      const endpoint = placed.get(fromTree ? relation.from : relation.to)!;
      place(outside, 3, endpoint.angle, unit * 0.54 + ghosts * 22, 0, true);
      ghosts++;
    }
  }
  // Draw every link whose endpoints survived, including links between ghosts.
  for (const relation of relations) {
    const a = placed.get(relation.from);
    const b = placed.get(relation.to);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const distance = Math.hypot(mx - cx, my - cy);
    const angle = distance > 0.001 ? Math.atan2(my - cy, mx - cx) : a.angle - Math.PI / 2;
    const bend = Math.max(30, Math.hypot(a.x - b.x, a.y - b.y) * 0.3);
    edges.push({ ...relation, path: `M ${a.x} ${a.y} Q ${mx + Math.cos(angle) * bend} ${my + Math.sin(angle) * bend} ${b.x} ${b.y}` });
  }
  return { nodes: [...placed.values()], edges, radius };
}
