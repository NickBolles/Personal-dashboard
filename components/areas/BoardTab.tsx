"use client";

import { useMemo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { ChipButton } from "@/components/ui/kit";
import { Branch, MAP_KEY, mapWorkItems, type MapResponse } from "@/components/map/MapView";
import { AreaPickerDot, SelectPicker } from "@/components/work/MetaPicker";
import { ItemFilterBar, NO_FILTER, type ItemFilter } from "@/components/work/ItemMeta";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { areaRollups, MAP_BUCKET_LABELS, MAP_BUCKETS, matchesFilter, type MapBucket } from "@/lib/map-rollup";
import { isContainer, type WorkItem } from "@/lib/work";
import "@/components/map/map.css";

const BUCKET_TONE = { owner: "wn", inflight: "ac", next: "inf", live: "ok", backlog: null, done: "ok" } as const;

/** The existing editable drill-down, scoped independently from the selected row. */
export function BoardTab({ scopeId, selectedId, onOpen }: { scopeId: string | null; selectedId?: string | null; onOpen?: (id: string) => void }): JSX.Element {
  // Reset transient filters on a scope change, without an effect/state waterfall.
  return <ScopedBoard key={scopeId ?? "all"} scopeId={scopeId} selectedId={selectedId} onOpen={onOpen} />;
}

function ScopedBoard({ scopeId, selectedId, onOpen }: { scopeId: string | null; selectedId?: string | null; onOpen?: (id: string) => void }) {
  const q = useQuery({ queryKey: MAP_KEY, queryFn: () => api.get<MapResponse>("/api/work/overview") });
  const [area, setArea] = useState("");
  const [bucket, setBucket] = useState<MapBucket | "">("");
  const [meta, setMeta] = useState<ItemFilter>(NO_FILTER);
  const [search, setSearch] = useState("");
  const [op, setOp] = useState<UndoOp | null>(null);
  const all = useMemo(() => mapWorkItems(q.data?.items ?? []), [q.data]);
  const { byId, kids } = useMemo(() => {
    const byId = new Map(all.map((i) => [i.id, i]));
    const kids = new Map<string | null, WorkItem[]>();
    for (const i of all) {
      const siblings = kids.get(i.parentId) ?? [];
      siblings.push(i);
      kids.set(i.parentId, siblings);
    }
    return { byId, kids };
  }, [all]);
  // A work row scopes to its nearest parent container, including work-under-work.
  const scope = useMemo(() => {
    let node = scopeId ? byId.get(scopeId) : undefined;
    const seen = new Set<string>();
    while (node && !isContainer(node) && !seen.has(node.id)) {
      seen.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return node && isContainer(node) ? node : null;
  }, [byId, scopeId]);
  const items = useMemo(() => {
    const root = scopeId ? scope?.id : area || null;
    if (scopeId && !root) return [];
    if (!root) return all;
    const keep = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (keep.has(id)) continue;
      keep.add(id);
      stack.push(...(kids.get(id) ?? []).map((i) => i.id));
    }
    return all.filter((i) => keep.has(i.id));
  }, [all, area, kids, scope, scopeId]);
  const rolls = useMemo(() => areaRollups(all), [all]);
  const filtering = !!(bucket || meta.tag || meta.assignee || search.trim());
  const visible = useMemo(() => {
    const keep = new Set<string>();
    const filter = { bucket: bucket || undefined, tag: meta.tag ?? undefined, assignee: meta.assignee ?? undefined, q: search };
    for (const i of items) {
      if (!filtering) {
        keep.add(i.id);
        continue;
      }
      if (isContainer(i) || !matchesFilter(i, filter)) continue;
      for (let c: WorkItem | undefined = i; c && !keep.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) keep.add(c.id);
    }
    return keep;
  }, [items, byId, bucket, meta, search, filtering]);
  const areas = rolls.filter((r) => (!area || r.id === area) && (!scope || scope.id === r.id) && visible.has(r.id));
  const branchRoot = scope && scope.parentId !== null ? scope : null;
  const shown = items.filter((i) => visible.has(i.id) && !isContainer(i)).length;
  const branch = (parent: string) => (
    <Branch
      parent={parent}
      kids={kids}
      visible={visible}
      open={filtering || !!scope || !!selectedId}
      depth={1}
      links={q.data!.links}
      relations={q.data!.relations}
      onOp={setOp}
      selectedId={selectedId}
      onOpen={onOpen}
    />
  );
  return (
    <section aria-labelledby="map-tree-h" className="min-w-0 pb-24">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id="map-tree-h" className="wk-label">
          Drill down <span className="text-muted">· {shown} shown</span>
        </h3>
      </div>
      {q.error ? <p className="text-sm text-danger">Couldn&apos;t load the map: {(q.error as Error).message}</p> : null}
      {!q.data && !q.error ? (
        <p className="text-sm text-muted" role="status">
          Loading the map…
        </p>
      ) : null}
      {q.data ? (
        <>
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Map filters">
            <label htmlFor="map-search" className="sr-only">
              Search the map
            </label>
            <input
              id="map-search"
              type="search"
              className="k-pick min-w-0 flex-1 basis-40 px-2"
              placeholder="Search titles and next actions"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {!scopeId ? (
              <>
                <label htmlFor="map-area" className="sr-only">
                  Filter by area
                </label>
                <SelectPicker
                  id="map-area"
                  label="Filter by area"
                  className="w-36"
                  active={!!area}
                  value={area}
                  onChange={setArea}
                  options={[
                    { value: "", label: "All areas" },
                    ...rolls.map((r) => ({ value: r.id, label: r.title, dot: <AreaPickerDot color={byId.get(r.id)?.settings?.color} /> })),
                  ]}
                />
              </>
            ) : null}
            <label htmlFor="map-status" className="sr-only">
              Filter by status
            </label>
            <SelectPicker
              id="map-status"
              label="Filter by status"
              active={!!bucket}
              value={bucket}
              onChange={(v) => setBucket(v as MapBucket | "")}
              options={[
                { value: "", label: "Any status" },
                ...MAP_BUCKETS.map((b) => ({ value: b, label: MAP_BUCKET_LABELS[b], dot: <AreaPickerDot color={BUCKET_TONE[b]} /> })),
              ]}
            />
            <ItemFilterBar rows={items} value={meta} onChange={setMeta} idPrefix="map" />
            {area || filtering ? (
              <ChipButton
                onClick={() => {
                  setArea("");
                  setBucket("");
                  setSearch("");
                  setMeta(NO_FILTER);
                }}
              >
                Reset
              </ChipButton>
            ) : null}
          </div>
          {branchRoot && visible.has(branchRoot.id) ? (
            <div className="space-y-2" data-testid="map-tree" key={`${branchRoot.id}-${filtering}`}>
              {branch(branchRoot.id)}
            </div>
          ) : areas.length ? (
            <div className="space-y-2" data-testid="map-tree" key={filtering ? "f" : "a"}>
              {areas.map((r) => (
                <details key={r.id} className="mp-area" open>
                  <summary className="mp-sum">
                    <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{r.title}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {r.total} {r.total === 1 ? "item" : "items"}
                    </span>
                  </summary>
                  {branch(r.id)}
                </details>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted" data-testid="map-empty">
              Nothing matches these filters.
            </p>
          )}
        </>
      ) : null}
      {op ? <UndoBar key={op.id} op={op} onDone={() => setOp(null)} /> : null}
    </section>
  );
}
