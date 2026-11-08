"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog, ErrorNote, LoadingState } from "@/components/ui";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { bucketOf, emptyCounts, MAP_BUCKET_LABELS, MAP_BUCKETS, type BucketCounts, type MapBucket } from "@/lib/map-rollup";
import { isContainer, type WorkItem } from "@/lib/work";
import { useAgentRuns } from "@/components/agents/AgentRuns";
import { CoordinatorButton } from "@/components/agents/CoordinatorPane";
import { whoLabel } from "@/lib/agent-runs";
import { Branch, MAP_KEY, type MapResponse } from "./MapView";
import { useShowArchived } from "@/lib/client/show-archived";
import "./map.css";

const BUCKET_TONE: Record<MapBucket, string> = { owner: "wn", inflight: "ac", next: "inf", live: "ok", backlog: "neutral", done: "ok" };
/** Which open item's next action a project card shows: what waits on you first, then what's moving. */
const NEXT_ORDER: MapBucket[] = ["owner", "inflight", "next", "live", "backlog"];

function descendants(kids: Map<string | null, WorkItem[]>, id: string): WorkItem[] {
  const out: WorkItem[] = [];
  const walk = (p: string, depth: number) => {
    if (depth > 40) return;
    for (const c of kids.get(p) ?? []) {
      out.push(c);
      walk(c.id, depth + 1);
    }
  };
  walk(id, 0);
  return out;
}

type Card = { item: WorkItem; counts: BucketCounts; total: number; next: WorkItem | null; needsYou: number; ids: Set<string> };

/**
 * Area page default ("Map is Areas" PR 2): one card per project one level down
 * (bucket rollups, next action, active agents, Needs you), then the item tree
 * with "depends on" / "follow-up of" relation chips. Cards · Tree switch.
 * Data: the same /api/work/overview read as the /areas landing.
 */
export function AreaProjects({ areaId, onOpen }: { areaId: string; onOpen?: (id: string) => void }) {
  // Show archived (#183): an archived area's projects only come back with ?archived=1.
  const [archived] = useShowArchived();
  const q = useQuery({
    queryKey: archived ? [...MAP_KEY, "archived"] : MAP_KEY,
    queryFn: () => api.get<MapResponse>(`/api/work/overview${archived ? "?archived=1" : ""}`),
  });
  const runs = useAgentRuns().data;
  const [view, setView] = useState<"cards" | "tree">("cards");
  const [op, setOp] = useState<UndoOp | null>(null);
  const kids = useMemo(() => {
    const m = new Map<string | null, WorkItem[]>();
    const all = q.data?.items ?? [];
    const byId = new Map(all.map((i) => [i.id, i]));
    // Conversations are hidden here: work split beneath one hangs off its nearest visible ancestor instead.
    const parentOf = (i: WorkItem) => {
      let p = i.parentId;
      for (let n = 0; p && byId.get(p)?.kind === "conversation" && n < 40; n++) p = byId.get(p)!.parentId;
      return p;
    };
    for (const i of all)
      if (!i.archived && i.kind !== "conversation") {
        const p = parentOf(i);
        m.set(p, [...(m.get(p) ?? []), i]);
      }
    return m;
  }, [q.data]);
  const cards: Card[] = useMemo(
    () =>
      (kids.get(areaId) ?? [])
        .filter((k) => isContainer(k))
        .map((p) => {
          const all = descendants(kids, p.id);
          const work = all.filter((i) => !isContainer(i));
          const counts = emptyCounts();
          for (const i of work) counts[bucketOf(i)]++;
          let next: WorkItem | null = null;
          for (const b of NEXT_ORDER) {
            next = work.find((i) => bucketOf(i) === b && i.nextAction?.trim()) ?? null;
            if (next) break;
          }
          return {
            item: p,
            counts,
            total: work.length,
            next,
            needsYou: work.filter((i) => bucketOf(i) === "owner").length,
            // The project itself too: runs of conversations filed directly under it are attributed to it.
            ids: new Set([p.id, ...all.map((i) => i.id)]),
          };
        }),
    [kids, areaId],
  );
  // Cards view: the cards already cover each project, so the list below them holds only the area's loose items
  // (one list per level, no duplicate project rows). Tree view: everything, with relation chips.
  const treeKids = useMemo(() => {
    if (view === "tree") return kids;
    const m = new Map(kids);
    m.set(
      areaId,
      (kids.get(areaId) ?? []).filter((k) => !isContainer(k)),
    );
    return m;
  }, [kids, areaId, view]);
  if (!q.data) return q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : <LoadingState label="Loading projects…" />;
  const visible = new Set(descendants(treeKids, areaId).map((i) => i.id));
  const hasTree = visible.size > 0;
  return (
    <section aria-labelledby="ap-h" className="ap-root min-w-0" data-testid="area-projects">
      <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 id="ap-h" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
          {view === "cards" ? "Projects" : "Tree"}
        </h3>
        <div role="group" aria-label="Area view" className="ap-seg">
          {(["cards", "tree"] as const).map((v) => (
            <button key={v} type="button" className="ap-seg-item" aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "cards" ? "Cards" : "Tree"}
            </button>
          ))}
        </div>
      </div>
      {view === "cards" ? (
        cards.length ? (
          <ul className="mp-cards mb-4" data-testid="area-project-cards">
            {cards.map((c) => {
              const agents = (runs?.active ?? []).filter((a) => c.ids.has(a.itemId) && a.live !== "idle");
              return (
                <li key={c.item.id} className="min-w-0">
                  <Link
                    href={`/areas?item=${encodeURIComponent(c.item.id)}`}
                    className="mp-card"
                    data-testid="area-project-card"
                    onClick={(e) => {
                      if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onOpen(c.item.id);
                    }}
                  >
                    <span className="truncate font-semibold">{c.item.title}</span>
                    <span className="mp-counts" aria-label={MAP_BUCKETS.map((b) => `${MAP_BUCKET_LABELS[b]} ${c.counts[b]}`).join(", ")}>
                      {MAP_BUCKETS.map((b) =>
                        c.counts[b] ? (
                          <span key={b} className="mp-count" data-tone={BUCKET_TONE[b]} aria-hidden="true">
                            <b>{c.counts[b]}</b> {MAP_BUCKET_LABELS[b]}
                          </span>
                        ) : null,
                      )}
                      {!c.total ? (
                        <span className="text-xs text-muted" aria-hidden="true">
                          No items yet
                        </span>
                      ) : null}
                    </span>
                    <span className="mp-bar" aria-hidden="true">
                      {MAP_BUCKETS.map((b) => (c.counts[b] ? <i key={b} data-tone={BUCKET_TONE[b]} style={{ flexGrow: c.counts[b] }} /> : null))}
                    </span>
                    <span className="min-w-0 text-[13px] [overflow-wrap:anywhere]">
                      <span className="text-muted">Next · </span>
                      {c.next ? c.next.nextAction : <span className="text-muted">No next action yet</span>}
                    </span>
                    {c.needsYou || agents.length ? (
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {c.needsYou ? <span className="mp-flag">{c.needsYou} needs you</span> : null}
                        {agents.slice(0, 3).map((a) => (
                          <span key={a.itemId} className="ap-agent" title={a.title}>
                            <i aria-hidden="true" data-live={a.live} />
                            {a.who ? whoLabel(a.who) : "Agent"}
                          </span>
                        ))}
                        {agents.length > 3 ? <span className="text-xs text-muted">+{agents.length - 3}</span> : null}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mb-3 text-[13px] text-muted">No projects yet. Add one to group related work.</p>
        )
      ) : null}
      {hasTree ? (
        <div className="min-w-0" data-testid="area-tree">
          {view === "cards" ? <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Other items</h3> : null}
          <Branch
            parent={areaId}
            kids={treeKids}
            visible={visible}
            open={view === "tree"}
            depth={1}
            links={q.data.links}
            relations={q.data.relations}
            onOp={setOp}
          />
        </div>
      ) : null}
      {op ? <UndoBar key={op.id} op={op} onDone={() => setOp(null)} /> : null}
    </section>
  );
}

export type DiscussionRow = { key: string; sessionId: string; title: string; note: string };

/** Coordinator panel body: open the coordinator chat, start a new discussion here, previous discussions. */
function CoordinatorBody({ area, chats, onNew, busy }: { area: { id: string; title: string }; chats: DiscussionRow[]; onNew: () => void; busy: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CoordinatorButton areaId={area.id} areaTitle={area.title} />
        <Button size="sm" variant="primary" loading={busy} onClick={onNew} data-testid="area-coordinator-new">
          New
          <span className="sr-only"> discussion in {area.title}</span>
        </Button>
      </div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Previous discussions</h4>
      {chats.length ? (
        <ul className="ap-disc" data-testid="area-discussions">
          {chats.slice(0, 8).map((c) => (
            <li key={c.key}>
              <Link href={`/chat/${encodeURIComponent(c.sessionId)}`} className="ap-disc-row">
                <span className="min-w-0 flex-1 truncate">{c.title || "Untitled chat"}</span>
                <span className="shrink-0 text-xs text-muted">{c.note}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No discussions in this area yet.</p>
      )}
      {chats.length > 8 ? <p className="text-xs text-muted">+{chats.length - 8} more in Chats</p> : null}
    </div>
  );
}

/**
 * The area coordinator: a persistent right column at ≥1280 px, a button that
 * opens the same content as a sheet below that (phones, foldables, tablets).
 * Callers hide it for AI-excluded areas.
 */
export function AreaCoordinator({
  variant,
  ...props
}: {
  variant: "column" | "sheet";
  area: { id: string; title: string };
  chats: DiscussionRow[];
  onNew: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (variant === "column")
    return (
      <section aria-labelledby="ac-h" className="ap-coord" data-testid="area-coordinator">
        <h3 id="ac-h" className="font-semibold [overflow-wrap:anywhere]">
          {props.area.title} coordinator
        </h3>
        <CoordinatorBody {...props} />
      </section>
    );
  return (
    <div className="ap-coord-open">
      <Button size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="area-coordinator-sheet-open">
        Coordinator · {props.chats.length} {props.chats.length === 1 ? "discussion" : "discussions"}
      </Button>
      {open ? (
        <Dialog open onClose={() => setOpen(false)} title={`${props.area.title} coordinator`}>
          <CoordinatorBody {...props} />
        </Dialog>
      ) : null}
    </div>
  );
}
