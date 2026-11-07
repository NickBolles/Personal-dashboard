"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { SectionHeader } from "@/components/ui/kit";
import { SelectPicker, StatusPickerDot } from "@/components/work/MetaPicker";
import { InlineText, useInlinePatch } from "@/components/work/InlineEdit";
import { ItemChips } from "@/components/work/ItemMeta";
import { StatusDot, fmtDate } from "@/components/work/common";
import type { UndoOp } from "@/components/work/UndoBar";
import { areaRollups, bucketOf, MAP_BUCKET_LABELS, MAP_BUCKETS, type AreaRollup, type MapBucket } from "@/lib/map-rollup";
import { isContainer, todayIso, STATUS_LABELS, WORK_STATUSES, type WorkItem, type WorkStatus } from "@/lib/work";
import { digest, type DigestRow } from "@/lib/areas-digest";
import type { DecisionsResponse } from "@/lib/decisions";
import { NeedsYouSection, useDecisions } from "./Decisions";
import { AgentLine, AgentsStrip, useAgentRuns } from "@/components/agents/AgentRuns";
import { CoordinatorButton } from "@/components/agents/CoordinatorPane";
import { activeInArea } from "@/lib/agent-runs";
import { isFinanceAreaLike } from "@/lib/catch-up";
import { itemAgentChip } from "@/components/work/AgentChip";

export type MapLink = { kind: string; url: string; title: string | null };
export type MapRelation = { kind: "depends" | "followup"; id: string; title: string; open: boolean };
export type MapResponse = {
  items: WorkItem[];
  links: Record<string, MapLink[]>;
  /** older servers/stubs omit it */
  relations?: Record<string, MapRelation[]>;
  decisions: DecisionsResponse;
};
export const MAP_KEY = ["work", "overview"] as const;

const BUCKET_TONE: Record<MapBucket, string> = { owner: "wn", inflight: "ac", next: "inf", live: "ok", backlog: "neutral", done: "ok" };

function linkLabel(l: MapLink) {
  if (l.kind === "chat_session") return l.title || "Chat";
  const m = /github\.com\/[^/]+\/([^/]+)\/(pull|issues)\/(\d+)/.exec(l.url);
  if (m) return `${m[2] === "pull" ? "PR" : "Issue"} #${m[3]}`;
  if (/\/v\/[^/]+/.test(l.url)) return l.title || "Board";
  return l.title || l.url.replace(/^https?:\/\//, "").slice(0, 32);
}

/** Hide conversations while keeping work split beneath them in the tree. */
export function mapWorkItems(source: WorkItem[]): WorkItem[] {
  const all = source.filter((i) => !i.archived);
  const byId = new Map(all.map((i) => [i.id, i]));
  const keptParent = (id: string | null) => {
    let c = id ? byId.get(id) : undefined;
    for (let n = 0; c && c.kind === "conversation" && n < 100; n++) c = c.parentId ? byId.get(c.parentId) : undefined;
    return c ? c.id : id && !byId.has(id) ? id : null;
  };
  return all
    .filter((i) => i.kind !== "conversation")
    .map((i) => (i.parentId && byId.get(i.parentId)?.kind === "conversation" ? { ...i, parentId: keptParent(i.parentId) } : i));
}

const PHONE = "(max-width: 639.98px)";
function subscribePhone(callback: () => void) {
  const media = window.matchMedia(PHONE);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const phoneSnapshot = () => window.matchMedia(PHONE).matches;
const serverPhone = () => false;

/** The Overview landing; the scoped drill-down lives in BoardTab. */
export function MapView({ onOpen }: { onOpen?: (id: string) => void } = {}) {
  const q = useQuery({ queryKey: MAP_KEY, queryFn: () => api.get<MapResponse>("/api/work/overview") });
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, serverPhone);
  // The polling decisions query wins over the overview snapshot (approvals change outside work edits).
  const dq = useDecisions();
  const items = useMemo(() => mapWorkItems(q.data?.items ?? []), [q.data]);
  const rolls = useMemo(() => areaRollups(items), [items]);
  const today = todayIso();
  const moving = useMemo(() => digest(items, today), [items, today]);
  const runs = useAgentRuns().data;
  const agentCount = useMemo(() => rolls.reduce((n, r) => n + activeInArea(runs, r.id).length, 0), [rolls, runs]);

  return (
    <div className="mp-root min-w-0 pb-24" data-testid="map-page">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg leading-tight font-semibold tracking-tight">Overview</h2>
          <p className="mt-0.5 text-[13px] text-muted" data-dynamic>
            {rolls.length} {rolls.length === 1 ? "area" : "areas"} · {items.filter((i) => !isContainer(i) && bucketOf(i) !== "done").length} open
            {agentCount ? ` · ${agentCount} ${agentCount === 1 ? "agent" : "agents"} working` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/areas/today" className="k-pick inline-flex items-center px-3 text-[13px]" data-testid="work-queue-link">
            Work queue
          </Link>
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

      {q.data ? (
        <div className="mp-land mb-5">
          <section aria-labelledby="map-areas-h" className="min-w-0">
            <h3 id="map-areas-h" className="wk-label mb-1.5">
              Areas
            </h3>
            <ul className="mp-cards" data-testid="map-overview">
              {rolls.map((r) => (
                <AreaCard key={r.id} roll={r} onOpen={onOpen} />
              ))}
            </ul>
          </section>
          <aside aria-label="Coordination" className="mp-land-side flex min-w-0 flex-col gap-3">
            <ChiefOfStaffSlot items={items} onOpen={onOpen} />
            <NeedsYouSection entries={dq.data?.entries ?? q.data.decisions.entries} id="map-needs-you-h" limit={phone ? 3 : 5} />
            <DigestSection kind="inflight" rows={moving.inflight} total={moving.inflightTotal} items={items} onOpen={onOpen} />
            <DigestSection kind="outstanding" rows={moving.outstanding} total={moving.outstandingTotal} items={items} onOpen={onOpen} />
          </aside>
        </div>
      ) : null}
    </div>
  );
}

const REASON_LABEL: Record<DigestRow["reason"], string> = { needs_you: "Needs you", overdue: "Overdue", next: "Next", inflight: "In progress" };
function DigestSection({
  kind,
  rows,
  total,
  items,
  onOpen,
}: {
  kind: "inflight" | "outstanding";
  rows: DigestRow[];
  total: number;
  items: WorkItem[];
  onOpen?: (id: string) => void;
}) {
  const runs = useAgentRuns().data;
  const byId = new Map(items.map((i) => [i.id, i]));
  const id = `digest-${kind}-h`;
  return (
    <section aria-labelledby={id} data-testid={`digest-${kind}`} className="mp-digest min-w-0">
      <SectionHeader id={id} label={kind === "inflight" ? "In progress" : "Outstanding"} count={total} />
      {rows.length ? (
        <ul className="mp-digest-list">
          {rows.map((r) => {
            const live = runs?.items[r.id]?.live;
            return (
              <li key={r.id}>
                <Link
                  href={`/areas?item=${encodeURIComponent(r.id)}`}
                  className="mp-digest-row"
                  onClick={(e) => {
                    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpen(r.id);
                  }}
                >
                  <StatusDot status={byId.get(r.id)!.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.title}</span>
                    <span className="block truncate text-xs text-muted">{r.path}</span>
                    {kind === "outstanding" ? (
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <span className="mp-flag" data-reason={r.reason}>
                          {REASON_LABEL[r.reason]}
                        </span>
                        <span className="truncate text-xs text-muted" data-dynamic>
                          {r.nextAction}
                        </span>
                      </span>
                    ) : null}
                  </span>
                  {live === "running" || live === "waiting" ? (
                    <span className="mp-digest-agent" data-live={live} role="img" aria-label={`Agent ${live}`} />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">{kind === "inflight" ? "Nothing in progress." : "Nothing outstanding."}</p>
      )}
      {total > 5 ? (
        <Link href="/areas?tab=board" className="mp-digest-all">
          Show all {total}
        </Link>
      ) : null}
    </section>
  );
}

function AreaCard({ roll: r, onOpen }: { roll: AreaRollup; onOpen?: (id: string) => void }) {
  const open = r.total - r.counts.done;
  const agents = activeInArea(useAgentRuns().data, r.id);
  return (
    <li className="relative flex min-w-0 flex-col gap-1">
      {/* A real link (bookmarks, new tab); inside /areas it opens the area in place. */}
      <Link
        href={`/areas?item=${encodeURIComponent(r.id)}`}
        className={isFinanceAreaLike(r) ? "mp-card" : "mp-card mp-card-co"}
        onClick={(e) => {
          if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(r.id);
        }}
        data-testid="map-area-card"
      >
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
        <span className="mp-card-meta text-xs text-muted" data-dynamic>
          {r.projects} {r.projects === 1 ? "project" : "projects"} · last activity {r.lastActivity ? fmtDate(r.lastActivity) : "—"}
        </span>
        {agents.length ? (
          <span className="mp-card-agents relative block min-w-0">
            <span className="sr-only">
              {agents.length} active {agents.length === 1 ? "agent" : "agents"}:
            </span>
            <AgentsStrip entries={agents} max={2} />
          </span>
        ) : null}
      </Link>
      {/* Finance never goes to AI: no coordinator chat there. */}
      {/* ✦ icon in the card's top-right corner (N5); the card reserves room for it (.mp-card-co). */}
      {isFinanceAreaLike(r) ? null : <CoordinatorButton areaId={r.id} areaTitle={r.title} className="mp-card-coord" />}
    </li>
  );
}

/** The agent mode that makes an area's coordinator the primary one ("Chief of staff"). */
export const CHIEF_OF_STAFF_MODE = "chiefofstaff";

/** The area whose coordinator is the Chief of staff: a top-level, non-finance area with agent mode `chiefofstaff`. */
export function chiefOfStaffArea(items: WorkItem[]): WorkItem | null {
  return (
    items.find(
      (i) =>
        i.kind === "area" &&
        i.parentId === null &&
        !i.archived &&
        (i.settings?.agentMode ?? "").trim().toLowerCase() === CHIEF_OF_STAFF_MODE &&
        !isFinanceAreaLike(i),
    ) ?? null
  );
}

/**
 * The primary coordinator slot. Shows the Chief of staff area's coordinator
 * (opens its pane: latest discussion + composer; sends nothing by itself), or
 * an empty state explaining how to set it up. No invented activity.
 */
function ChiefOfStaffSlot({ items, onOpen }: { items: WorkItem[]; onOpen?: (id: string) => void }) {
  const area = chiefOfStaffArea(items);
  if (!area)
    return (
      <section aria-labelledby="cos-h" className="mp-cos" data-testid="chief-of-staff" data-state="empty">
        <h3 id="cos-h" className="font-semibold">
          Set up Chief of staff
        </h3>
        <p className="text-[13px] text-muted">
          One coordinator that sees every area. Open an area (for example Portfolio), then Area settings → Agent mode <code>chiefofstaff</code>.
        </p>
      </section>
    );
  return (
    <section aria-labelledby="cos-h" className="mp-cos" data-testid="chief-of-staff" data-state="set">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-[1_1_10rem]">
          <h3 id="cos-h" className="font-semibold">
            Chief of staff
          </h3>
          <p className="text-[13px] text-muted [overflow-wrap:anywhere]">
            Coordinates every area from{" "}
            <Link
              href={`/areas?item=${encodeURIComponent(area.id)}`}
              className="text-accent hover:underline"
              onClick={(e) => {
                if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(area.id);
              }}
            >
              {area.title}
            </Link>{" "}
            · @{CHIEF_OF_STAFF_MODE}
          </p>
        </div>
        <CoordinatorButton areaId={area.id} areaTitle={area.title} className="shrink-0" />
      </div>
    </section>
  );
}

export function Branch({
  parent,
  kids,
  visible,
  open,
  depth,
  links,
  relations,
  onOp,
  selectedId,
  onOpen,
}: {
  parent: string;
  kids: Map<string | null, WorkItem[]>;
  visible: Set<string>;
  open: boolean;
  depth: number;
  links: Record<string, MapLink[]>;
  relations?: Record<string, MapRelation[]>;
  onOp: (op: UndoOp) => void;
  selectedId?: string | null;
  onOpen?: (id: string) => void;
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
              {/* #166: the title gets priority; the rollup wraps under it on phones instead of squeezing it. */}
              <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2" data-testid="map-proj-sum">
                <span className="min-w-0 flex-[1_1_9rem] font-medium [overflow-wrap:anywhere]">{g.title}</span>
                <span className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
                  {MAP_BUCKETS.filter((b) => counts[b])
                    .map((b) => `${counts[b]} ${MAP_BUCKET_LABELS[b].toLowerCase()}`)
                    .join(" · ") || "empty"}
                </span>
              </span>
            </summary>
            <Branch
              parent={g.id}
              kids={kids}
              visible={visible}
              open={open}
              depth={depth + 1}
              links={links}
              relations={relations}
              onOp={onOp}
              selectedId={selectedId}
              onOpen={onOpen}
            />
          </details>
        );
      })}
      {rows.length ? (
        <ul className="mp-rows">
          {rows.map((i) => (
            <MapRow key={i.id} item={i} links={links[i.id] ?? []} relations={relations?.[i.id]} onOp={onOp} selected={selectedId === i.id} onOpen={onOpen}>
              <Branch
                parent={i.id}
                kids={kids}
                visible={visible}
                open={open}
                depth={depth + 1}
                links={links}
                relations={relations}
                onOp={onOp}
                selectedId={selectedId}
                onOpen={onOpen}
              />
            </MapRow>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MapRow({
  item: i,
  links,
  relations = [],
  onOp,
  children,
  selected,
  onOpen,
}: {
  item: WorkItem;
  links: MapLink[];
  relations?: MapRelation[];
  onOp: (op: UndoOp) => void;
  children?: React.ReactNode;
  selected?: boolean;
  onOpen?: (id: string) => void;
}) {
  const patch = useInlinePatch(i.id, (op) => (op ? onOp(op) : undefined));
  const b = bucketOf(i);
  const agent = useAgentRuns().data?.items[i.id];
  const row = useRef<HTMLLIElement>(null);
  // Only a selection made while the board is open scrolls; mounting with one (tab switch) keeps the page still.
  const scrolled = useRef(!!selected);
  useEffect(() => {
    if (selected && !scrolled.current) row.current?.scrollIntoView({ block: "nearest" });
    scrolled.current = !!selected;
  }, [selected]);
  return (
    <li ref={row} className={selected ? "mp-row mp-row-sel" : "mp-row"} data-testid="map-row" data-bucket={b} data-selected={selected ? "true" : undefined}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot status={i.status} />
        <Link
          href={`/areas?item=${encodeURIComponent(i.id)}`}
          className="mp-row-title min-w-0 flex-1 basis-40 truncate text-[13px] font-medium hover:underline"
          onClick={(e) => {
            if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onOpen(i.id);
          }}
        >
          {i.title}
        </Link>
        {i.decision ? <span className="mp-flag">Needs you</span> : null}
        <label htmlFor={`mp-st-${i.id}`} className="sr-only">
          Status of {i.title}
        </label>
        <SelectPicker
          id={`mp-st-${i.id}`}
          label={`Status of ${i.title}`}
          value={i.status}
          active={false}
          onChange={(v) => patch.mutate({ status: v as WorkStatus })}
          className="w-32 max-w-full"
          options={WORK_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s], dot: <StatusPickerDot status={s} /> }))}
        />
      </div>
      <div className="mt-0.5 pl-4 text-[13px] text-muted">
        <InlineText field="nextAction" value={i.nextAction} status={i.status} placeholder="Add a next action" onSave={(v) => patch.mutate({ nextAction: v })}>
          {i.nextAction ? <span>Next: {i.nextAction}</span> : <span className="italic">No next action</span>}
        </InlineText>
      </div>
      {agent && (agent.live !== "idle" || agent.who?.kind === "agent") ? (
        <div className="mt-1 min-w-0 pl-4">
          <AgentLine info={agent} />
        </div>
      ) : null}
      {relations.length ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 pl-4" data-testid="map-relations">
          {relations.map((r) => (
            <Link
              key={`${r.kind}-${r.id}`}
              href={`/areas?item=${encodeURIComponent(r.id)}`}
              className="mp-rel"
              data-kind={r.kind}
              data-open={r.open ? "true" : undefined}
            >
              {r.kind === "depends" ? "depends on" : "follow-up of"} <b>{r.title}</b>
            </Link>
          ))}
        </div>
      ) : null}
      {i.tags.length || i.assignee || links.length || i.createdVia || i.updatedVia ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 pl-4">
          {itemAgentChip(i)}
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
