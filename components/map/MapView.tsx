"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx } from "@/components/ui";
import { ChipButton, ChipSelect } from "@/components/ui/kit";
import { InlineText, useInlinePatch } from "@/components/work/InlineEdit";
import { ItemChips, ItemFilterBar, NO_FILTER, type ItemFilter } from "@/components/work/ItemMeta";
import { StatusDot, fmtDate } from "@/components/work/common";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { areaRollups, bucketOf, MAP_BUCKET_LABELS, MAP_BUCKETS, matchesFilter, type AreaRollup, type MapBucket } from "@/lib/map-rollup";
import { isContainer, STATUS_LABELS, WORK_STATUSES, type WorkItem, type WorkStatus } from "@/lib/work";
import type { DecisionsResponse } from "@/lib/decisions";
import { NeedsYouSection } from "./Decisions";

type MapLink = { kind: string; url: string; title: string | null };
export type MapResponse = { items: WorkItem[]; links: Record<string, MapLink[]>; decisions: DecisionsResponse };
export const MAP_KEY = ["work", "overview"] as const;

const BUCKET_TONE: Record<MapBucket, string> = { owner: "wn", inflight: "ac", next: "inf", live: "ok", backlog: "neutral", done: "ok" };

function linkLabel(l: MapLink) {
  if (l.kind === "chat_session") return l.title || "Chat";
  const m = /github\.com\/[^/]+\/([^/]+)\/(pull|issues)\/(\d+)/.exec(l.url);
  if (m) return `${m[2] === "pull" ? "PR" : "Issue"} #${m[3]}`;
  if (/\/v\/[^/]+/.test(l.url)) return l.title || "Board";
  return l.title || l.url.replace(/^https?:\/\//, "").slice(0, 32);
}

/**
 * /map: the portfolio overview. Area cards with Live / In flight / Next /
 * Backlog / Blocked-on-you / Done rollups, then the Area → Project → Item tree
 * with filter chips, search, inline status + next action and each row's links.
 */
export function MapView() {
  const q = useQuery({ queryKey: MAP_KEY, queryFn: () => api.get<MapResponse>("/api/work/overview") });
  const [area, setArea] = useState("");
  const [bucket, setBucket] = useState<MapBucket | "">("");
  const [meta, setMeta] = useState<ItemFilter>(NO_FILTER);
  const [search, setSearch] = useState("");
  const [op, setOp] = useState<UndoOp | null>(null);
  const items = useMemo(() => (q.data?.items ?? []).filter((i) => !i.archived && i.kind !== "conversation"), [q.data]);
  const rolls = useMemo(() => areaRollups(items), [items]);
  const filter = { bucket: bucket || undefined, tag: meta.tag ?? undefined, assignee: meta.assignee ?? undefined, q: search };
  const filtering = !!(bucket || meta.tag || meta.assignee || search.trim());
  const kids = useMemo(() => {
    const m = new Map<string | null, WorkItem[]>();
    for (const i of items) m.set(i.parentId, [...(m.get(i.parentId) ?? []), i]);
    return m;
  }, [items]);
  // Which items survive the filters: matching work items plus every container on their path.
  const visible = useMemo(() => {
    const keep = new Set<string>();
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const i of items) {
      if (isContainer(i)) continue;
      if (!matchesFilter(i, filter)) continue;
      for (let c: WorkItem | undefined = i, n = 0; c && n < 100; c = c.parentId ? byId.get(c.parentId) : undefined, n++) keep.add(c.id);
    }
    if (!filtering) for (const i of items) keep.add(i.id);
    return keep;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter is derived from the listed state
  }, [items, bucket, meta, search, filtering]);
  const areas = rolls.filter((r) => (!area || r.id === area) && visible.has(r.id));
  const shown = items.filter((i) => visible.has(i.id) && !isContainer(i)).length;

  return (
    <div className="mx-auto max-w-6xl px-3 pt-3 pb-24 sm:px-5" data-testid="map-page">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="wk-eyebrow">Work from Jarvis</p>
          <h1 className="text-xl leading-tight font-semibold tracking-tight">Map</h1>
          <p className="mt-0.5 text-[13px] text-muted" data-dynamic>
            {rolls.length} {rolls.length === 1 ? "area" : "areas"} · {items.filter((i) => !isContainer(i)).length} items
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/decisions" className="k-pick inline-flex items-center px-3 text-[13px]">
            Needs you{q.data?.decisions.count ? ` · ${q.data.decisions.count}` : ""}
          </Link>
          <a href="/api/work/overview/export" download className="k-pick inline-flex items-center px-3 text-[13px]">
            Export JSON
          </a>
        </div>
      </header>

      {q.error ? <p className="text-sm text-danger">Couldn&apos;t load the map: {(q.error as Error).message}</p> : null}
      {!q.data && !q.error ? (
        <p className="text-sm text-muted" role="status">
          Loading the map…
        </p>
      ) : null}

      {q.data ? <NeedsYouSection entries={q.data.decisions.entries} id="map-needs-you-h" limit={5} /> : null}

      {q.data ? (
        <section aria-labelledby="map-areas-h" className="mb-5">
          <h2 id="map-areas-h" className="wk-label mb-1.5">
            Overview
          </h2>
          <ul className="mp-cards" data-testid="map-overview">
            {rolls.map((r) => (
              <AreaCard key={r.id} roll={r} active={area === r.id} onPick={() => setArea(area === r.id ? "" : r.id)} />
            ))}
          </ul>
        </section>
      ) : null}

      {q.data ? (
        <section aria-labelledby="map-tree-h">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="map-tree-h" className="wk-label">
              Drill down <span className="text-muted">· {shown} shown</span>
            </h2>
          </div>
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
            <label htmlFor="map-area" className="sr-only">
              Filter by area
            </label>
            <ChipSelect id="map-area" className="w-36 [&>select]:w-full" active={!!area} value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">All areas</option>
              {rolls.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </ChipSelect>
            <label htmlFor="map-status" className="sr-only">
              Filter by status
            </label>
            <ChipSelect id="map-status" active={!!bucket} value={bucket} onChange={(e) => setBucket(e.target.value as MapBucket | "")}>
              <option value="">Any status</option>
              {MAP_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {MAP_BUCKET_LABELS[b]}
                </option>
              ))}
            </ChipSelect>
            <ItemFilterBar rows={items} value={meta} onChange={setMeta} idPrefix="map" />
            {area || bucket || search ? (
              <ChipButton
                onClick={() => {
                  setArea("");
                  setBucket("");
                  setSearch("");
                }}
              >
                Reset
              </ChipButton>
            ) : null}
          </div>
          {areas.length ? (
            <div className="space-y-2" data-testid="map-tree" key={filtering ? "f" : "a"}>
              {areas.map((r) => (
                <details key={r.id} className="mp-area" open>
                  <summary className="mp-sum">
                    <span className="font-semibold">{r.title}</span>
                    <span className="text-xs text-muted">
                      {r.total} {r.total === 1 ? "item" : "items"}
                    </span>
                  </summary>
                  <Branch parent={r.id} kids={kids} visible={visible} open={filtering} depth={1} links={q.data!.links} onOp={setOp} />
                </details>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted" data-testid="map-empty">
              Nothing matches these filters.
            </p>
          )}
        </section>
      ) : null}
      {op ? <UndoBar key={op.id} op={op} onDone={() => setOp(null)} /> : null}
    </div>
  );
}

function AreaCard({ roll: r, active, onPick }: { roll: AreaRollup; active: boolean; onPick: () => void }) {
  const open = r.total - r.counts.done;
  return (
    <li>
      <button type="button" className={cx("mp-card", active && "mp-card-on")} aria-pressed={active} onClick={onPick} data-testid="map-area-card">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate font-semibold">{r.title}</span>
          <span className="shrink-0 text-xs text-muted">{open} open</span>
        </span>
        <span className="mp-counts" aria-label={MAP_BUCKETS.map((b) => `${MAP_BUCKET_LABELS[b]} ${r.counts[b]}`).join(", ")}>
          {MAP_BUCKETS.map((b) =>
            r.counts[b] ? (
              <span key={b} className="mp-count" data-tone={BUCKET_TONE[b]} aria-hidden="true">
                <b>{r.counts[b]}</b> {MAP_BUCKET_LABELS[b]}
              </span>
            ) : null,
          )}
          {!r.total ? (
            <span className="text-xs text-muted" aria-hidden="true">
              No items yet
            </span>
          ) : null}
        </span>
        <span className="mp-bar" aria-hidden="true">
          {MAP_BUCKETS.map((b) => (r.counts[b] ? <i key={b} data-tone={BUCKET_TONE[b]} style={{ flexGrow: r.counts[b] }} /> : null))}
        </span>
        <span className="text-xs text-muted" data-dynamic>
          {r.projects} {r.projects === 1 ? "project" : "projects"} · last activity {r.lastActivity ? fmtDate(r.lastActivity) : "—"}
        </span>
      </button>
    </li>
  );
}

function Branch({
  parent,
  kids,
  visible,
  open,
  depth,
  links,
  onOp,
}: {
  parent: string;
  kids: Map<string | null, WorkItem[]>;
  visible: Set<string>;
  open: boolean;
  depth: number;
  links: Record<string, MapLink[]>;
  onOp: (op: UndoOp) => void;
}) {
  const list = (kids.get(parent) ?? []).filter((i) => visible.has(i.id));
  if (!list.length) return null;
  const groups = list.filter((i) => isContainer(i));
  const rows = list.filter((i) => !isContainer(i));
  return (
    <div className="mp-branch">
      {groups.map((g) => {
        const all = (kids.get(g.id) ?? []).filter((i) => !isContainer(i));
        const counts = all.reduce<Partial<Record<MapBucket, number>>>((a, i) => ((a[bucketOf(i)] = (a[bucketOf(i)] ?? 0) + 1), a), {});
        return (
          <details key={g.id} className="mp-proj" open={open || undefined}>
            <summary className="mp-sum">
              <span className="min-w-0 truncate font-medium">{g.title}</span>
              <span className="shrink-0 text-xs text-muted">
                {MAP_BUCKETS.filter((b) => counts[b])
                  .map((b) => `${counts[b]} ${MAP_BUCKET_LABELS[b].toLowerCase()}`)
                  .join(" · ") || "empty"}
              </span>
            </summary>
            <Branch parent={g.id} kids={kids} visible={visible} open={open} depth={depth + 1} links={links} onOp={onOp} />
          </details>
        );
      })}
      {rows.length ? (
        <ul className="mp-rows">
          {rows.map((i) => (
            <MapRow key={i.id} item={i} links={links[i.id] ?? []} onOp={onOp}>
              <Branch parent={i.id} kids={kids} visible={visible} open={open} depth={depth + 1} links={links} onOp={onOp} />
            </MapRow>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MapRow({ item: i, links, onOp, children }: { item: WorkItem; links: MapLink[]; onOp: (op: UndoOp) => void; children?: React.ReactNode }) {
  const patch = useInlinePatch(i.id, (op) => (op ? onOp(op) : undefined));
  const b = bucketOf(i);
  return (
    <li className="mp-row" data-testid="map-row" data-bucket={b}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot status={i.status} />
        <Link href={`/areas?item=${encodeURIComponent(i.id)}`} className="min-w-0 flex-1 basis-40 truncate text-[13px] font-medium hover:underline">
          {i.title}
        </Link>
        {i.decision ? <span className="mp-flag">Needs you</span> : null}
        <label htmlFor={`mp-st-${i.id}`} className="sr-only">
          Status of {i.title}
        </label>
        <ChipSelect
          id={`mp-st-${i.id}`}
          value={i.status}
          onChange={(e) => patch.mutate({ status: e.target.value as WorkStatus })}
          className="w-32 [&>select]:w-full"
        >
          {WORK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </ChipSelect>
      </div>
      <div className="mt-0.5 pl-4 text-[13px] text-muted">
        <InlineText field="nextAction" value={i.nextAction} status={i.status} placeholder="Add a next action" onSave={(v) => patch.mutate({ nextAction: v })}>
          {i.nextAction ? <span>Next: {i.nextAction}</span> : <span className="italic">No next action</span>}
        </InlineText>
      </div>
      {i.tags.length || i.assignee || links.length ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 pl-4">
          <ItemChips tags={i.tags} assignee={i.assignee} />
          {links.map((l, n) =>
            l.url.startsWith("/") ? (
              <Link key={n} href={l.url} className="mp-link">
                {linkLabel(l)}
              </Link>
            ) : (
              <a key={n} href={l.url} target="_blank" rel="noreferrer" className="mp-link">
                {linkLabel(l)}
              </a>
            ),
          )}
        </div>
      ) : null}
      {children}
    </li>
  );
}
