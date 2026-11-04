"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Empty, ErrorNote, Spinner, inputCls, useToast } from "@/components/ui";
import { ChipSelect } from "@/components/ui/kit";
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  ACTOR_LABELS,
  groupByDay,
  type ActivityItem,
  type ActivityResponse,
  type ActivityType,
  type ActorKind,
} from "@/lib/activity";
import { matchesItemFilter } from "@/lib/item-tags";
import type { ItemsResponse } from "@/lib/work";
import { ItemFilterBar, NO_FILTER, type ItemFilter } from "./ItemMeta";
import { AgentChip } from "./AgentChip";

/** Glyph per row type (text glyphs keep rows light; aria-hidden — the verb carries the meaning). */
const GLYPH: Record<ActivityType, string> = {
  edit: "✎",
  status: "◐",
  created: "+",
  structure: "↳",
  link: "↗",
  github: "#",
  capture: "⇣",
  chat: "✦",
  validation: "✓",
  chore: "☑",
};

const POLL_MS = 30_000;
/** Filter controls sit in one wrapping row, so drop the shared input's full width. */

export type ActivityScope = { item?: string; descendants?: boolean };

function useTimeZone() {
  return useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago", []);
}

/**
 * Unified activity timeline (per item, per area/project subtree, or global): grouped by day with
 * sticky day headers, compact rows, type/actor filters, search, "Load older" cursor paging, a
 * 30 s live poll and Undo on rows whose op is still undoable.
 */
export function ActivityFeed({
  scope = {},
  onSelect,
  compact = false,
  areas,
  initialArea = "",
  label = "Activity",
}: {
  scope?: ActivityScope;
  onSelect?: (id: string) => void;
  compact?: boolean;
  /** global view: area filter options */
  areas?: { id: string; title: string }[];
  initialArea?: string;
  label?: string;
}) {
  const [type, setType] = useState<ActivityType | "">("");
  const [actor, setActor] = useState<ActorKind | "">("");
  const [area, setArea] = useState(initialArea);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const tz = useTimeZone();
  const toast = useToast();
  const qc = useQueryClient();
  const item = scope.item ?? (area || undefined);
  const descendants = scope.item ? Boolean(scope.descendants) : Boolean(area);
  const params = new URLSearchParams();
  if (item) params.set("item", item);
  if (descendants) params.set("descendants", "1");
  if (type) params.set("type", type);
  if (actor) params.set("actor", actor);
  if (q) params.set("q", q);
  params.set("limit", compact ? "20" : "50");
  const base = params.toString();
  const feed = useInfiniteQuery({
    queryKey: ["activity", base],
    queryFn: ({ pageParam }) => api.get<ActivityResponse>(`/api/work/activity?${base}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_MS,
  });
  // #111: the global timeline filters by the tags/assignee of the item each row is about.
  const [itemFilter, setItemFilter] = useState<ItemFilter>(NO_FILTER);
  const workItems = useQuery({ queryKey: ["work", "items", false], queryFn: () => api.get<ItemsResponse>("/api/work/items"), enabled: !!areas });
  const tagged = useMemo(() => workItems.data?.items ?? [], [workItems.data]);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const rows = (feed.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    if (!itemFilter.tag && !itemFilter.assignee) return rows;
    const keep = new Set(tagged.filter((w) => matchesItemFilter({ tags: w.tags ?? [], assignee: w.assignee ?? null }, itemFilter)).map((w) => w.id));
    return rows.filter((r) => !!r.object && keep.has(r.object.id));
  }, [feed.data, itemFilter, tagged]);
  const groups = useMemo(() => groupByDay(items, tz), [items, tz]);
  const [undoing, setUndoing] = useState<string | null>(null);

  const undo = async (row: ActivityItem) => {
    if (!row.undoOpId) return;
    setUndoing(row.id);
    try {
      await api.post(`/api/work/ops/${encodeURIComponent(row.undoOpId)}/undo`, {});
      toast.toast("Undone");
      await Promise.all([qc.invalidateQueries({ queryKey: ["activity"] }), qc.invalidateQueries({ queryKey: ["work"] })]);
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : "Couldn't undo", "danger");
    } finally {
      setUndoing(null);
    }
  };

  const filtersId = `act-${compact ? "c" : "g"}`;
  const more = feed.hasNextPage ? (
    <div className="jv-activity-more">
      <Button size="sm" busy={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
        Load older
      </Button>
    </div>
  ) : null;
  return (
    <section className="jv-activity" aria-label={label}>
      <form
        role="search"
        aria-label={`Filter ${label.toLowerCase()}`}
        className="jv-activity-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <label htmlFor={`${filtersId}-q`} className="sr-only">
          Search activity
        </label>
        <input
          id={`${filtersId}-q`}
          type="search"
          className={`${inputCls.replace(/\bblock w-full\b/, "")} jv-activity-q`}
          placeholder="Search activity"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) setQ("");
          }}
        />
        <label htmlFor={`${filtersId}-type`} className="sr-only">
          Type
        </label>
        <ChipSelect id={`${filtersId}-type`} active={!!type} value={type} onChange={(e) => setType(e.target.value as ActivityType | "")}>
          <option value="">All types</option>
          {ACTIVITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACTIVITY_TYPE_LABELS[t]}
            </option>
          ))}
        </ChipSelect>
        <label htmlFor={`${filtersId}-actor`} className="sr-only">
          Who
        </label>
        <ChipSelect id={`${filtersId}-actor`} active={!!actor} value={actor} onChange={(e) => setActor(e.target.value as ActorKind | "")}>
          <option value="">Anyone</option>
          {(Object.keys(ACTOR_LABELS) as ActorKind[]).map((a) => (
            <option key={a} value={a}>
              {ACTOR_LABELS[a]}
            </option>
          ))}
        </ChipSelect>
        {areas ? (
          <>
            <label htmlFor={`${filtersId}-area`} className="sr-only">
              Area
            </label>
            {/* Fixed width: a native select sizes to its longest option, so long area names would widen the chip and wrap the filter row. */}
            <ChipSelect id={`${filtersId}-area`} className="w-36 [&>select]:w-full" active={!!area} value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">All areas</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </ChipSelect>
          </>
        ) : null}
      </form>
      {areas ? <ItemFilterBar rows={tagged} value={itemFilter} onChange={setItemFilter} idPrefix={`${filtersId}-meta`} className="mb-2" /> : null}
      {feed.isPending ? (
        <Spinner label="Loading activity" />
      ) : feed.isError ? (
        <ErrorNote error={feed.error} retry={() => feed.refetch()} />
      ) : !items.length ? (
        <>
          <Empty title={q || type || actor || area || itemFilter.tag || itemFilter.assignee ? "Nothing matches these filters" : "No activity yet"} />
          {/* tag/assignee filters run on loaded pages: keep older pages reachable when this one has no match */}
          {more}
        </>
      ) : (
        <div className="jv-activity-days">
          {groups.map((g) => (
            <div key={g.day} className="jv-activity-day">
              <h4 className="jv-activity-dayh">
                <time dateTime={g.day}>{g.label}</time>
              </h4>
              <ol className="jv-activity-list">
                {g.items.map((r) => (
                  <li key={r.id} className="jv-activity-row" data-type={r.type}>
                    <span className="jv-activity-glyph" data-actor={r.actor.kind} aria-hidden="true">
                      {GLYPH[r.type]}
                    </span>
                    <span className="jv-activity-text">
                      {r.via ? <AgentChip profile={r.via} /> : <span className="jv-activity-actor">{r.actor.name}</span>} <span>{r.verb}</span>{" "}
                      {r.object && !(scope.item === r.object.id && !scope.descendants) ? (
                        onSelect ? (
                          <button type="button" className="jv-activity-obj" onClick={() => onSelect(r.object!.id)}>
                            {r.object.title}
                          </button>
                        ) : (
                          <Link className="jv-activity-obj" href={`/areas?item=${encodeURIComponent(r.object.id)}`}>
                            {r.object.title}
                          </Link>
                        )
                      ) : null}
                      {r.detail ? <span className="jv-activity-detail"> · {r.detail}</span> : null}
                    </span>
                    {r.undoOpId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="jv-activity-undo"
                        busy={undoing === r.id}
                        onClick={() => undo(r)}
                        aria-label={`Undo: ${r.verb}`}
                      >
                        Undo
                      </Button>
                    ) : null}
                    <time className="jv-activity-time" dateTime={r.at} data-dynamic>
                      {new Date(r.at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}
                    </time>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {more}
        </div>
      )}
    </section>
  );
}
