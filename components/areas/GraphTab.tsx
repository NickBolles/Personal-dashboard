"use client";

import "./graph.css";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type JSX, type Ref, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAgentRuns } from "@/components/agents/AgentRuns";
import { MAP_KEY, type MapResponse } from "@/components/map/MapView";
import { Button } from "@/components/ui";
import { STATUS_VAR } from "@/components/work/WorkMap";
import { api } from "@/lib/client/api";
import { bucketOf, emptyCounts, MAP_BUCKET_LABELS, MAP_BUCKETS } from "@/lib/map-rollup";
import { radialLabelBox, radialLayout, type PlacedNode, type RadialNodeIn, type RadialRelation } from "@/lib/radial-layout";
import { isContainer, STATUS_LABELS, type WorkItem } from "@/lib/work";
import type { AgentRunsResponse } from "@/lib/agent-runs";

type GraphTabProps = {
  items: WorkItem[];
  centreId: string | null;
  onRecentre: (id: string | null) => void;
  onOpen: (id: string) => void;
};

type CameraControls = { fit: () => void; zoom: (factor: number) => void };

/** Hide conversations/archives without losing the work filed beneath them. */
function graphItems(items: WorkItem[]) {
  const all = new Map(items.map((item) => [item.id, item]));
  const kept = items.filter((item) => !item.archived && item.kind !== "conversation");
  const keptIds = new Set(kept.map((item) => item.id));
  const parents = new Map<string, string | null>();
  const nearest = (id: string | null): string | null => {
    let current = id;
    const path: string[] = [];
    const seen = new Set<string>();
    while (current && !keptIds.has(current) && !parents.has(current) && !seen.has(current)) {
      seen.add(current);
      path.push(current);
      current = all.get(current)?.parentId ?? null;
    }
    const parent = current && keptIds.has(current) ? current : current ? (parents.get(current) ?? null) : null;
    for (const skipped of path) parents.set(skipped, parent);
    return parent;
  };
  return { items: kept.map((item) => ({ ...item, parentId: nearest(item.parentId) })), nearest, all };
}

/** Read-only radial work tree; selection and tab navigation remain with WorkView. */
export function GraphTab({ items, centreId, onRecentre, onOpen }: GraphTabProps): JSX.Element {
  const overview = useQuery({ queryKey: MAP_KEY, queryFn: () => api.get<MapResponse>("/api/work/overview") });
  const runs = useAgentRuns().data;
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<CameraControls>(null);
  const [size, setSize] = useState({ root: 800, width: 800, height: 480 });
  const [showList, setShowList] = useState(false);
  const normalized = useMemo(() => graphItems(items), [items]);
  const byId = useMemo(() => new Map(normalized.items.map((item) => [item.id, item])), [normalized]);
  const selectedId = centreId ? normalized.nearest(centreId) : null;
  const centre = selectedId ? byId.get(selectedId) : undefined;
  const title = centre?.title ?? "All areas";
  const compact = size.root < 560;
  const listMode = showList || size.root < 260;

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage) return;
    const observer = new ResizeObserver((entries) => {
      setSize((old) => {
        const next = { ...old };
        for (const entry of entries) {
          if (entry.target === root) next.root = entry.contentRect.width;
          // A hidden list-mode canvas reports zero; keep its last usable size.
          if (entry.target === stage && entry.contentRect.width > 0) {
            next.width = entry.contentRect.width;
            next.height = entry.contentRect.height;
          }
        }
        return next.root === old.root && next.width === old.width && next.height === old.height ? old : next;
      });
    });
    observer.observe(root);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const children = useMemo(() => {
    const out = new Map<string | null, WorkItem[]>();
    for (const item of normalized.items) {
      const list = out.get(item.parentId);
      if (list) list.push(item);
      else out.set(item.parentId, [item]);
    }
    return out;
  }, [normalized]);
  const direct = (children.get(selectedId) ?? []).filter((item) => item.id !== selectedId && (selectedId !== null || item.kind === "area"));
  const breadcrumbs = useMemo(() => {
    const path: WorkItem[] = [];
    const seen = new Set<string>();
    let current = centre;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path.reverse();
  }, [centre, byId]);
  const graph = useMemo(() => {
    const nodes: RadialNodeIn[] = [...normalized.items];
    const known = new Set(nodes.map((node) => node.id));
    const relations: RadialRelation[] = [];
    for (const [from, links] of Object.entries(overview.data?.relations ?? {})) {
      if (!byId.has(from)) continue;
      for (const link of links) {
        // Never reintroduce an explicitly hidden archived/conversation item.
        if (normalized.all.has(link.id) && !byId.has(link.id)) continue;
        if (!known.has(link.id)) {
          known.add(link.id);
          nodes.push({ id: link.id, title: link.title, status: link.open ? "captured" : "settled", kind: "thread", parentId: null });
        }
        relations.push({ from, to: link.id, kind: link.kind });
      }
    }
    return { nodes, relations };
  }, [normalized, byId, overview.data?.relations]);
  const relationIndex = useMemo(() => {
    // Both ends list the link (incoming ones read in reverse), so the list fallback keeps every relation.
    const index = new Map<string, { kind: RadialRelation["kind"]; other: string; incoming: boolean }[]>();
    const add = (at: string, entry: { kind: RadialRelation["kind"]; other: string; incoming: boolean }) => {
      const list = index.get(at);
      if (list) list.push(entry);
      else index.set(at, [entry]);
    };
    for (const relation of graph.relations) {
      add(relation.from, { kind: relation.kind, other: relation.to, incoming: false });
      add(relation.to, { kind: relation.kind, other: relation.from, incoming: true });
    }
    return index;
  }, [graph]);
  const names = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.title])), [graph]);
  // Work below the centre by status (projects are groups, not work: count the items inside them).
  const counts = emptyCounts();
  const below = [...direct];
  for (let n = 0; n < below.length && n < 5000; n++) below.push(...(children.get(below[n].id) ?? []));
  for (const item of below) if (!isContainer(item)) counts[bucketOf(item)]++;
  const hasRelations = graph.relations.some((relation) => relation.from === selectedId || relation.to === selectedId);
  const listNode = (item: Pick<WorkItem, "id" | "title" | "status">, depth: number, ancestors: Set<string>): JSX.Element => {
    const seen = new Set(ancestors).add(item.id);
    const kids = depth < 2 ? (item.id === "__all" ? direct : (children.get(item.id) ?? [])).filter((child) => !seen.has(child.id)) : [];
    return (
      <li key={item.id}>
        <button type="button" className="ar-graph-list-node" onClick={() => onRecentre(item.id === "__all" ? null : item.id)}>
          <span>{item.title}</span> <span className="ar-graph-muted">{STATUS_LABELS[item.status]}</span>
        </button>
        {(relationIndex.get(item.id) ?? []).map((relation, i) => (
          <p className="ar-graph-list-relation" key={`${relation.kind}-${relation.other}-${relation.incoming}-${i}`}>
            {relation.kind === "depends" ? (relation.incoming ? "needed by" : "depends on") : relation.incoming ? "has follow-up" : "follow-up of"}{" "}
            <button type="button" onClick={() => onRecentre(relation.other)}>
              {names.get(relation.other) ?? relation.other}
            </button>
          </p>
        ))}
        {kids.length ? <ul>{kids.map((child) => listNode(child, depth + 1, seen))}</ul> : null}
      </li>
    );
  };

  return (
    <section ref={rootRef} aria-label="Graph" data-testid="graph-tab" className="ar-graph">
      <header className="ar-graph-header">
        <nav aria-label="Graph breadcrumb" className="ar-graph-breadcrumb">
          <button type="button" onClick={() => onRecentre(null)} aria-current={!centre ? "location" : undefined}>
            All areas
          </button>
          {breadcrumbs.map((item) => (
            <span key={item.id}>
              <span aria-hidden="true">›</span>
              <button type="button" onClick={() => onRecentre(item.id)} aria-current={item.id === selectedId ? "location" : undefined}>
                {item.title}
              </button>
            </span>
          ))}
        </nav>
        <div className="ar-graph-controls" role="group" aria-label="Graph controls">
          <Button type="button" size="sm" className="ar-graph-control" disabled={listMode} onClick={() => cameraRef.current?.fit()}>
            Fit
          </Button>
          <Button type="button" size="sm" className="ar-graph-control" disabled={listMode} aria-label="Zoom out" onClick={() => cameraRef.current?.zoom(0.8)}>
            −
          </Button>
          <Button type="button" size="sm" className="ar-graph-control" disabled={listMode} aria-label="Zoom in" onClick={() => cameraRef.current?.zoom(1.25)}>
            +
          </Button>
          <Button type="button" size="sm" className="ar-graph-control" aria-pressed={listMode} onClick={() => setShowList(!showList)}>
            Show as list
          </Button>
        </div>
      </header>
      {overview.error ? (
        <p className="ar-graph-muted" role="status">
          Relations unavailable; the work tree is still shown.
        </p>
      ) : null}
      <div className="ar-graph-body">
        <div className="ar-graph-main">
          <div ref={stageRef} className="ar-graph-stage" hidden={listMode}>
            <GraphCanvas
              key={`${selectedId ?? "__all"}:${compact}`}
              title={title}
              centreId={selectedId}
              graph={graph}
              size={size}
              compact={compact}
              controlsRef={cameraRef}
              runs={runs}
              onRecentre={onRecentre}
              onOpen={onOpen}
              onShowList={() => setShowList(true)}
            />
          </div>
          {listMode ? (
            <ul className="ar-graph-list" aria-label={`List of ${title}`}>
              {listNode(centre ?? { id: "__all", title, status: "captured" }, 0, new Set())}
            </ul>
          ) : null}
          {!direct.length && !hasRelations ? <p className="ar-graph-muted ar-graph-empty">Nothing below {title} yet.</p> : null}
          <div className="ar-graph-legend" aria-label="Graph legend">
            <span>
              <i data-kind="contains" />
              contains
            </span>
            <span>
              <i data-kind="depends" />
              depends on
            </span>
            <span>
              <i data-kind="followup" />
              follow-up
            </span>
            <span>
              <i data-kind="agent" />
              agent running
            </span>
          </div>
          <p className="ar-graph-muted ar-graph-hint">Tap a node to re-centre · pinch or scroll to zoom</p>
        </div>
        <aside className="ar-graph-card" aria-label="Selected centre">
          <h3>{title}</h3>
          {centre ? (
            <>
              <p>{STATUS_LABELS[centre.status]}</p>
              <h4>Next action</h4>
              <p className="ar-graph-muted">{centre.nextAction || "No next action yet."}</p>
            </>
          ) : (
            <p className="ar-graph-muted">Select an area to explore its work.</p>
          )}
          <h4>Work below by status</h4>
          <dl>
            {MAP_BUCKETS.map((bucket) => (
              <div key={bucket}>
                <dt>{MAP_BUCKET_LABELS[bucket]}</dt>
                <dd>{counts[bucket]}</dd>
              </div>
            ))}
          </dl>
          {centre ? (
            <Button type="button" size="sm" className="ar-graph-control" onClick={() => onOpen(centre.id)}>
              Open
            </Button>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

type Point = { x: number; y: number };
type View = Point & { k: number };
const clamp = (scale: number) => Math.max(0.5, Math.min(3, scale));
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Isolated gesture state: selection changes reset the camera, not the list toggle. */
function GraphCanvas({
  title,
  centreId,
  graph,
  size,
  compact,
  controlsRef,
  runs,
  onRecentre,
  onOpen,
  onShowList,
}: {
  title: string;
  centreId: string | null;
  graph: { nodes: RadialNodeIn[]; relations: RadialRelation[] };
  size: { width: number; height: number };
  compact: boolean;
  controlsRef: Ref<CameraControls>;
  runs: AgentRunsResponse | undefined;
  onRecentre: GraphTabProps["onRecentre"];
  onOpen: GraphTabProps["onOpen"];
  onShowList: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const start = useRef<Point | null>(null);
  const dragged = useRef(false);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const padX = Math.min(86, size.width * 0.22);
  const padY = 68;
  const layout = useMemo(
    () =>
      radialLayout(centreId, graph.nodes, graph.relations, {
        width: Math.max(1, size.width - padX * 2),
        height: Math.max(1, size.height - padY * 2),
        compact,
      }),
    [centreId, graph, size.width, size.height, padX, compact],
  );
  const zoomAt = (factor: number, point: Point) =>
    setView((old) => {
      const k = clamp(old.k * factor);
      return { k, x: point.x - ((point.x - old.x) * k) / old.k, y: point.y - ((point.y - old.y) * k) / old.k };
    });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const point = { x: ((event.clientX - rect.left) * size.width) / rect.width, y: ((event.clientY - rect.top) * size.height) / rect.height };
      const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.006);
      setView((old) => {
        const k = clamp(old.k * factor);
        return { k, x: point.x - ((point.x - old.x) * k) / old.k, y: point.y - ((point.y - old.y) * k) / old.k };
      });
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [size.width, size.height]);
  const pointOf = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) * size.width) / rect.width, y: ((event.clientY - rect.top) * size.height) / rect.height };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const before = [...pointers.current.values()];
    const previous = pointers.current.get(event.pointerId)!;
    const point = pointOf(event);
    pointers.current.set(event.pointerId, point);
    if (start.current && distance(start.current, point) > 5) dragged.current = true;
    const after = [...pointers.current.values()];
    if (after.length >= 2) {
      dragged.current = true;
      const oldMid = midpoint(before[0], before[1]);
      const newMid = midpoint(after[0], after[1]);
      const ratio = distance(after[0], after[1]) / Math.max(1, distance(before[0], before[1]));
      setView((old) => {
        const k = clamp(old.k * ratio);
        return { k, x: newMid.x - ((oldMid.x - old.x) * k) / old.k, y: newMid.y - ((oldMid.y - old.y) * k) / old.k };
      });
    } else setView((old) => ({ ...old, x: old.x + point.x - previous.x, y: old.y + point.y - previous.y }));
  };
  const activate = (node: PlacedNode) => {
    if (node.id.startsWith("__more:")) onShowList();
    else if (node.ring === 0 && centreId) onOpen(centreId);
    else onRecentre(node.id === "__all" ? null : node.id);
  };
  const fit = () => {
    if (!layout.nodes.length) return setView({ x: 0, y: 0, k: 1 });
    // Include label extents and ghosts, not just dot centres.
    const boxes = layout.nodes.map((node) => ({ node, box: radialLabelBox(node) }));
    const left = Math.min(...boxes.map(({ node, box }) => Math.min(node.x - 80, box.left) + padX));
    const right = Math.max(...boxes.map(({ node, box }) => Math.max(node.x + 80, box.right) + padX));
    const top = Math.min(...boxes.map(({ node, box }) => Math.min(node.y - 32, box.top) + padY));
    const bottom = Math.max(...boxes.map(({ node, box }) => Math.max(node.y + 40, box.bottom + 20) + padY));
    const k = clamp(Math.min(1, (size.width - 24) / (right - left), (size.height - 24) / (bottom - top)));
    setView({ k, x: size.width / 2 - ((left + right) * k) / 2, y: size.height / 2 - ((top + bottom) * k) / 2 });
  };
  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
  };
  useImperativeHandle(controlsRef, () => ({ fit, zoom: (factor) => zoomAt(factor, { x: size.width / 2, y: size.height / 2 }) }));
  return (
    <>
      <svg
        ref={svgRef}
        role="group"
        aria-label={`Graph of ${title}`}
        data-testid="radial-graph"
        className="ar-graph-svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${size.width} ${size.height}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (!pointers.current.size) {
            dragged.current = false;
            start.current = pointOf(event);
          }
          pointers.current.set(event.pointerId, pointOf(event));
          if (pointers.current.size > 1) dragged.current = true;
          (event.target as Element).setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={(event) => {
          dragged.current = true;
          endPointer(event);
        }}
        onLostPointerCapture={endPointer}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g transform={`translate(${padX} ${padY})`}>
            {layout.edges.map((edge, i) => (
              <path
                key={`${edge.from}-${edge.to}-${edge.kind}-${i}`}
                className="ar-graph-edge"
                data-kind={edge.kind}
                d={edge.path}
                markerEnd={edge.kind === "contains" ? undefined : `url(#ar-arrow-${edge.kind})`}
              />
            ))}
            {layout.nodes.map((node) => {
              const live = runs?.items[node.id]?.live;
              const label = radialLabelBox(node);
              const labelX = label.x;
              const labelY = label.y;
              const centre = node.ring === 0;
              const pillWidth = Math.max(100, Math.min(158, Math.max(...node.lines.map((line) => line.length)) * 7 + 24));
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  data-node-id={node.id}
                  data-ring={node.ring}
                  data-centre={centre ? "true" : undefined}
                  data-ghost={node.ghost || undefined}
                  className="ar-graph-node"
                  transform={`translate(${node.x} ${node.y})`}
                  aria-label={`${node.title}, ${STATUS_LABELS[node.status]}${node.more ? `, ${node.more} more` : ""}`}
                  onClick={(event) => {
                    if (event.detail === 0 || !dragged.current) activate(node);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      activate(node);
                    }
                  }}
                >
                  <title>
                    {node.title}
                    {node.ghost ? " (related work)" : ""}
                  </title>
                  {centre ? (
                    <rect
                      className="ar-graph-shape"
                      x={-pillWidth / 2}
                      y={-node.lines.length * 8 - 10}
                      width={pillWidth}
                      height={node.lines.length * 16 + 20}
                      rx={18}
                      fill="var(--surface)"
                      stroke={STATUS_VAR[node.status]}
                    />
                  ) : (
                    <>
                      <circle className="ar-graph-hit" r={22} />
                      <circle className="ar-graph-shape" r={10} fill={STATUS_VAR[node.status]} stroke={STATUS_VAR[node.status]} />
                    </>
                  )}
                  {node.labelOffsetY ? <path className="ar-graph-label-leader" d={`M 0 ${Math.sign(node.labelOffsetY) * 12} L ${labelX} ${labelY}`} /> : null}
                  <text
                    className="ar-graph-label"
                    textAnchor={centre ? "middle" : node.anchor}
                    x={centre ? 0 : labelX}
                    y={centre ? -((node.lines.length - 1) * 15) / 2 + 4 : labelY}
                  >
                    {node.lines.map((line, i) => (
                      <tspan key={i} x={centre ? 0 : labelX} dy={i ? 15 : 0}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  {node.more ? (
                    <text className="ar-graph-more" textAnchor={node.anchor} x={labelX} y={Math.max(28, label.bottom - node.y + 15)}>
                      +{node.more}
                    </text>
                  ) : null}
                  {live === "running" || live === "waiting" ? (
                    <circle className="ar-graph-agent" data-live={live} cx={centre ? pillWidth / 2 - 2 : 9} cy={centre ? -node.lines.length * 8 - 6 : -9} r={4}>
                      <title>Agent {live}</title>
                    </circle>
                  ) : null}
                </g>
              );
            })}
          </g>
        </g>
        <defs>
          {(["depends", "followup"] as const).map((kind) => (
            // Arrowheads stop short of the 10px node dot so the direction (from → to) stays readable.
            <marker
              key={kind}
              id={`ar-arrow-${kind}`}
              className="ar-graph-arrow"
              data-kind={kind}
              viewBox="0 0 8 8"
              refX={20}
              refY={4}
              markerWidth={8}
              markerHeight={8}
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          ))}
        </defs>
      </svg>
    </>
  );
}
