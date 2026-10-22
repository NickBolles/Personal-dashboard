"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui";
import { STATUS_LABELS, type WorkStatus } from "@/lib/work";
import { MAP_NODE, MAP_RELATION_LABELS, layoutMap, type MapEdge, type MapGraphNode, type MapRelation } from "@/lib/work-map";
import { StatusBadge } from "./common";

/** Status colour as a CSS variable (SVG can't use the Tailwind bg classes). */
export const STATUS_VAR: Record<WorkStatus, string> = {
  captured: "var(--line-strong)",
  exploring: "var(--line-strong)",
  ready: "var(--accent)",
  in_progress: "var(--accent)",
  in_review: "var(--accent)",
  awaiting_validation: "var(--warn)",
  settled: "var(--ok)",
  reopened: "var(--danger)",
  on_hold: "var(--line)",
  superseded: "var(--line)",
  abandoned: "var(--line)",
};

export const EDGE_STYLE: Record<MapRelation, { stroke: string; dash?: string; arrow?: boolean }> = {
  tree: { stroke: "var(--line-strong)" },
  forked_from: { stroke: "var(--accent)", dash: "6 4", arrow: true },
  split_from: { stroke: "var(--accent)", dash: "2 3", arrow: true },
  handoff_from: { stroke: "var(--ok)", dash: "8 3 2 3", arrow: true },
  depends_on: { stroke: "var(--danger)", arrow: true },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function edgePath(e: MapEdge, a: { x: number; y: number }, b: { x: number; y: number }) {
  const { w, h } = MAP_NODE;
  if (e.relation === "tree") {
    const x1 = a.x + w / 2;
    const y1 = a.y + h;
    const x2 = b.x + w / 2;
    const y2 = b.y;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} V${my} H${x2} V${y2}`;
  }
  // Cross-links curve between node sides so they don't hide the tree.
  const x1 = a.x + (b.x >= a.x ? w : 0);
  const y1 = a.y + h / 2;
  const x2 = b.x + (b.x >= a.x ? 0 : w);
  const y2 = b.y + h / 2;
  const bend = Math.max(30, Math.abs(x2 - x1) / 3);
  const dir = b.x >= a.x ? 1 : -1;
  return `M${x1},${y1} C${x1 + dir * bend},${y1 - 24} ${x2 - dir * bend},${y2 - 24} ${x2},${y2}`;
}

/**
 * Pure SVG map of work items. Interactive mode pans (drag the background),
 * zooms (buttons, Ctrl/⌘ + wheel or plain wheel) and opens an item on click;
 * the snapshot mode is a fixed, fitted picture.
 */
export function MapCanvas({
  nodes,
  edges,
  interactive = true,
  height = 480,
  label,
}: {
  nodes: MapGraphNode[];
  edges: MapEdge[];
  interactive?: boolean;
  height?: number;
  label: string;
}) {
  const router = useRouter();
  const layout = useMemo(() => layoutMap(nodes), [nodes]);
  const pad = 16;
  const [view, setView] = useState({ x: pad, y: pad, k: 1 });
  const [pan, setPan] = useState<{ px: number; py: number; x: number; y: number } | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(3, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [interactive]);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = Math.min(1.5, Math.max(0.2, Math.min((r.width - 2 * pad) / layout.width, (r.height - 2 * pad) / layout.height)));
    setView({ k, x: (r.width - layout.width * k) / 2, y: pad });
  };
  const zoom = (f: number) =>
    setView((v) => {
      const r = ref.current?.getBoundingClientRect();
      const cx = (r?.width ?? 0) / 2;
      const cy = (r?.height ?? 0) / 2;
      const k = Math.min(3, Math.max(0.2, v.k * f));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });

  const snapK = interactive ? 1 : Math.min(1, 320 / Math.max(1, layout.width), (height - 2 * pad) / Math.max(1, layout.height));
  const t = interactive ? view : { x: pad, y: pad, k: snapK };
  const pos = layout.positions;

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive || e.button !== 0 || (e.target as Element).closest("a")) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPan({ px: e.clientX, py: e.clientY, x: view.x, y: view.y });
  };

  return (
    <div className="space-y-2">
      {interactive ? (
        <div role="group" aria-label="Zoom" className="flex flex-wrap gap-1">
          <Button size="sm" onClick={() => zoom(1.25)} aria-label="Zoom in">
            +
          </Button>
          <Button size="sm" onClick={() => zoom(0.8)} aria-label="Zoom out">
            −
          </Button>
          <Button size="sm" onClick={fit}>
            Fit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setView({ x: pad, y: pad, k: 1 })}>
            Reset
          </Button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
        <svg
          ref={ref}
          role="group"
          aria-label={label}
          data-map-nodes={nodes.length}
          data-map-edges={edges.length}
          width="100%"
          height={height}
          className={interactive ? (pan ? "cursor-grabbing touch-none" : "cursor-grab touch-none") : undefined}
          onPointerDown={onDown}
          onPointerMove={(e) => pan && setView((v) => ({ ...v, x: pan.x + e.clientX - pan.px, y: pan.y + e.clientY - pan.py }))}
          onPointerUp={() => setPan(null)}
          onPointerCancel={() => setPan(null)}
        >
          <defs>
            {(Object.keys(EDGE_STYLE) as MapRelation[]).map((r) => (
              <marker key={r} id={`map-arrow-${r}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill={EDGE_STYLE[r].stroke} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
            {edges.map((e) => {
              const a = pos[e.from];
              const b = pos[e.to];
              if (!a || !b) return null;
              const st = EDGE_STYLE[e.relation];
              return (
                <path
                  key={e.id}
                  data-edge={e.relation}
                  d={edgePath(e, a, b)}
                  fill="none"
                  stroke={st.stroke}
                  strokeWidth={e.relation === "tree" ? 1.25 : 1.75}
                  strokeDasharray={st.dash}
                  markerEnd={st.arrow ? `url(#map-arrow-${e.relation})` : undefined}
                />
              );
            })}
            {nodes.map((n) => {
              const p = pos[n.id];
              if (!p) return null;
              const body = (
                <>
                  <title>{`${n.title} (${STATUS_LABELS[n.status]})`}</title>
                  <rect width={MAP_NODE.w} height={MAP_NODE.h} rx={8} fill="var(--surface)" stroke={STATUS_VAR[n.status]} strokeWidth={2} />
                  <rect width={6} height={MAP_NODE.h} rx={3} fill={STATUS_VAR[n.status]} />
                  <text x={14} y={18} fontSize={12} fontWeight={n.kind === "area" || n.kind === "project" ? 600 : 400} fill="var(--text)">
                    {clip(n.title, 24)}
                  </text>
                  <text x={14} y={34} fontSize={10} fill="var(--muted)">
                    {STATUS_LABELS[n.status]}
                  </text>
                </>
              );
              return interactive ? (
                <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                  <a
                    href={`/work?item=${encodeURIComponent(n.id)}`}
                    aria-label={`${n.title}, ${STATUS_LABELS[n.status]}`}
                    data-node={n.id}
                    onClick={(e) => {
                      e.preventDefault();
                      router.push(`/work?item=${encodeURIComponent(n.id)}`);
                    }}
                    className="focus:outline-none [&:focus-visible>rect:first-of-type]:stroke-[var(--focus)] [&:focus-visible>rect:first-of-type]:stroke-[4]"
                  >
                    {body}
                  </a>
                </g>
              ) : (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} aria-hidden="true">
                  {body}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** Accessible equivalent of the map: the tree as nested lists, each item with its cross-links. */
export function MapList({ nodes, edges }: { nodes: MapGraphNode[]; edges: MapEdge[] }) {
  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string | null, MapGraphNode[]>();
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), n]);
  }
  for (const l of kids.values()) l.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const links = (id: string) =>
    edges
      .filter((e) => e.relation !== "tree" && (e.to === id || (e.relation === "depends_on" && e.from === id)))
      .map((e) =>
        e.to === id ? { key: e.id, text: MAP_RELATION_LABELS[e.relation], other: byId.get(e.from) } : { key: e.id, text: "Blocks", other: byId.get(e.to) },
      )
      .filter((x) => x.other);
  const render = (parent: string | null, depth: number) => (
    <ul className={depth ? "ml-4 border-l border-line pl-3" : ""}>
      {(kids.get(parent) ?? []).map((n) => (
        <li key={n.id} className="py-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/work?item=${encodeURIComponent(n.id)}`} className="font-medium break-words hover:underline">
              {n.title}
            </Link>
            <StatusBadge status={n.status} />
          </div>
          {links(n.id).length ? (
            <ul className="text-sm text-muted">
              {links(n.id).map((l) => (
                <li key={l.key}>
                  {l.text}{" "}
                  <Link href={`/work?item=${encodeURIComponent(l.other!.id)}`} className="text-accent underline">
                    {l.other!.title}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {kids.get(n.id)?.length ? render(n.id, depth + 1) : null}
        </li>
      ))}
    </ul>
  );
  return nodes.length ? render(null, 0) : <p className="text-sm text-muted">Nothing matches these filters.</p>;
}
