"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Card, Empty, ErrorNote, Field, PageHeader, Spinner, inputCls } from "@/components/ui";
import { EDGE_STYLE, MapCanvas, MapList } from "@/components/work/WorkMap";
import { isClosed, STATUS_LABELS, WORK_STATUSES, type WorkStatus } from "@/lib/work";
import { filterMap, MAP_RELATION_LABELS, MAP_RELATIONS, type MapGraph, type MapRelation } from "@/lib/work-map";

type StatusFilter = "all" | "open" | "closed" | WorkStatus;

/** Read-only orientation map (P2). Not the default view: the tree stays the place to edit. */
export function MapView({ initialRoot }: { initialRoot?: string }) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [relations, setRelations] = useState<Set<MapRelation>>(new Set(MAP_RELATIONS));
  const [status, setStatus] = useState<StatusFilter>("all");
  const [list, setList] = useState(false);
  const q = useQuery({
    queryKey: ["work", "map", root],
    queryFn: () => api.get<MapGraph>(`/api/work/map${root ? `?root=${encodeURIComponent(root)}` : ""}`),
  });
  const choose = (id: string) => {
    setRoot(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("root", id);
    else url.searchParams.delete("root");
    window.history.replaceState(null, "", url);
  };
  const shown = useMemo(() => {
    if (!q.data) return { nodes: [], edges: [] };
    const ok = (s: WorkStatus) => (status === "all" ? true : status === "open" ? !isClosed(s) : status === "closed" ? isClosed(s) : s === status);
    return filterMap(q.data, relations, ok);
  }, [q.data, relations, status]);
  const toggle = (r: MapRelation) =>
    setRelations((cur) => {
      const n = new Set(cur);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <PageHeader title="Map" subtitle="A read-only picture of how work relates: containment, forks, splits, follow-ups and dependencies. Edit in the tree." />
      <Card className="mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full min-w-0 sm:w-72">
            <Field id="map-root" label="Area or project">
              <select id="map-root" className={inputCls} value={root} onChange={(e) => choose(e.target.value)}>
                <option value="">All areas</option>
                {q.data?.roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="w-full min-w-0 sm:w-56">
            <Field id="map-status" label="Status">
              <select id="map-status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="all">All statuses</option>
                <option value="open">Open work</option>
                <option value="closed">Settled, superseded or abandoned</option>
                {WORK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button size="sm" aria-pressed={list} onClick={() => setList((l) => !l)}>
            {list ? "Show map" : "Show as list"}
          </Button>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Relations</legend>
          <div className="mt-1 flex flex-wrap gap-x-4">
            {MAP_RELATIONS.map((r) => (
              <label key={r} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={relations.has(r)} onChange={() => toggle(r)} />
                <svg aria-hidden="true" width="24" height="8">
                  <line x1="0" y1="4" x2="24" y2="4" stroke={EDGE_STYLE[r].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[r].dash} />
                </svg>
                {MAP_RELATION_LABELS[r]}
              </label>
            ))}
          </div>
        </fieldset>
      </Card>
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.isPending ? (
        <Spinner label="Loading map…" />
      ) : q.data && q.data.nodes.length ? (
        <Card className="p-2 sm:p-3">
          <h2 className="sr-only">{q.data.root ? q.data.root.title : "All areas"}</h2>
          {q.data.truncated ? (
            <p className="mb-2 text-sm text-warn">Showing the first {q.data.nodes.length} items. Pick an area or project to see the rest.</p>
          ) : null}
          {list ? (
            <MapList nodes={shown.nodes} edges={shown.edges} />
          ) : (
            <>
              <MapCanvas nodes={shown.nodes} edges={shown.edges} label={`Work map: ${q.data.root?.title ?? "all areas"}`} />
              <p className="mt-2 text-xs text-muted">Drag the background to pan; use the buttons or the mouse wheel to zoom. Select an item to open it.</p>
            </>
          )}
        </Card>
      ) : (
        <Empty title="Nothing to map">Add work items in the tree first.</Empty>
      )}
    </div>
  );
}
