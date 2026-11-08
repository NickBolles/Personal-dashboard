"use client";

import { useEffect, useMemo, useState } from "react";
import type { NextAction } from "@/lib/contracts";
import { localDate } from "@/lib/time";
import { cx } from "@/components/ui/kit";
import { CheckIcon } from "@/components/icons";
import { SkylightActionRow } from "./SkylightActionRow";
import { CHORE_BUCKETS, choreBucket, choreDay, choreTime, type ChoreBucket } from "./grouping";
import type { SkylightRequest } from "./useSkylightWrite";
import { applyOverlay, type WriteState } from "./writeState";
import { skylightWrites, useSkylightWriteState } from "./writeStore";

const clock = () => Date.now();
/** A write that landed this recently makes a just-cleared group (or day) celebrate once. */
const CELEBRATE_MS = 1_500;
const TODAY_BUCKETS: ChoreBucket[] = ["morning", "afternoon", "evening", "anytime"];

export type ChoreSection = { key: ChoreBucket; label: string; open: NextAction[]; done: NextAction[] };

const isChore = (a: NextAction) => a.source === "skylight" && (a.skylight === undefined || a.skylight.kind === "chore");

/**
 * Chores by Skylight's buckets with each bucket's progress: open rows (Skylight order) plus the ones done today.
 * A chore done today counts toward the bucket it was scheduled in, so "Morning 2/3" stays honest.
 */
export function choreSections(actions: NextAction[], opts: { now: Date | number; timezone: string; buckets?: readonly ChoreBucket[] }): ChoreSection[] {
  const today = localDate(opts.now, opts.timezone);
  const chores = actions.filter(isChore);
  const doneToday = (a: NextAction) =>
    a.status === "completed" && (a.skylight?.kind !== "chore" || !a.skylight.completedOn || a.skylight.completedOn === today);
  // #240: day first (Next 7 days: tomorrow 18:00 before next week 08:00), then time of day.
  const order = (a: NextAction) => `${choreDay(a, opts)} ${choreTime(a, opts.timezone) ?? "99:99"}`;
  return CHORE_BUCKETS.filter((b) => !opts.buckets || opts.buckets.includes(b.key))
    .map((b) => {
      const inBucket = chores.filter((a) => choreBucket({ ...a, status: "open" }, opts) === b.key);
      const open = inBucket
        .filter((a) => a.status === "open")
        .sort((x, y) => {
          if (b.key === "overdue") return order(y).localeCompare(order(x)) || x.title.localeCompare(y.title);
          return order(x).localeCompare(order(y)) || x.title.localeCompare(y.title);
        });
      const done = inBucket.filter(doneToday).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
      return { key: b.key, label: b.label, open, done };
    })
    .filter((s) => s.open.length || s.done.length);
}

/** Overlay-applied actions; fresh server rows reconcile (drop) overlay entries they now agree with. */
export function useOptimisticChores(actions: NextAction[], timezone: string): { actions: NextAction[]; writes: WriteState } {
  const writes = useSkylightWriteState();
  const [today] = useState(() => localDate(Date.now(), timezone));
  useEffect(() => {
    skylightWrites.reconcile(actions);
  }, [actions]);
  return { actions: useMemo(() => applyOverlay(actions, writes, today), [actions, writes, today]), writes };
}

const recent = (rows: NextAction[], writes: WriteState, now: number) =>
  rows.some((a) => {
    const e = writes[a.id];
    return e && (e.phase === "leaving" || e.phase === "done") && now - e.at < CELEBRATE_MS;
  });

/** n/m with a tick when n changes and a thin animated bar. */
function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="sk-progress" role="img" aria-label={`${label}: ${done} of ${total} done`}>
      <span aria-hidden="true" className="sk-count tabular-nums">
        <span key={done} className="sk-count-n">
          {done}
        </span>
        /{total}
      </span>
      <span aria-hidden="true" className="sk-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/**
 * Grouped chores (Morning / Afternoon / Evening / Anytime, then Next 7 days, Overdue last) with per-group progress,
 * a one-time Lagoon ring pulse when a group (or the whole day) is cleared, and every row completable in place.
 * `compact` (Today, tray card): today's buckets + Overdue, done rows folded into one "Done today" line.
 */
export function SkylightChoreGroups({
  actions,
  writable,
  request,
  timezone,
  now,
  compact,
  idPrefix,
  buckets,
  level = 3,
}: {
  actions: NextAction[];
  writable: boolean;
  request: SkylightRequest;
  timezone: string;
  now: number;
  compact?: boolean;
  idPrefix: string;
  buckets?: readonly ChoreBucket[];
  /** Heading level of the group titles (2 on the Skylight page, 3 inside a Today/tray card). */
  level?: 2 | 3;
}) {
  const H = level === 2 ? "h2" : "h3";
  const optimistic = useOptimisticChores(actions, timezone);
  const writes = optimistic.writes;
  const sections = choreSections(optimistic.actions, { now, timezone, buckets: buckets ?? (compact ? [...TODAY_BUCKETS, "overdue"] : undefined) });
  const todays = sections.filter((s) => TODAY_BUCKETS.includes(s.key));
  const dayOpen = todays.reduce((n, s) => n + s.open.length, 0);
  const dayDone = todays.reduce((n, s) => n + s.done.length, 0);
  const t = clock();
  const dayCleared = todays.length > 0 && dayOpen === 0;
  const doneRows = compact ? sections.flatMap((s) => s.done) : [];
  return (
    <div className={cx("sk-groups", compact && "sk-compact")}>
      {dayCleared ? (
        <p
          key={`day-${dayDone}`}
          className={cx(
            "sk-day flex items-center gap-2 text-sm font-medium",
            recent(
              todays.flatMap((s) => s.done),
              writes,
              t,
            ) && "sk-celebrate",
          )}
          role="status"
        >
          <span aria-hidden="true" className="sk-ring">
            <CheckIcon className="h-3 w-3" />
          </span>
          All of today’s chores are done
          <span className="text-xs font-normal text-muted tabular-nums">{dayDone}</span>
        </p>
      ) : null}
      {sections.map((s) => {
        const id = `${idPrefix}-${s.key}`;
        const total = s.open.length + s.done.length;
        const cleared = s.open.length === 0;
        return (
          <section key={s.key} aria-labelledby={id} className={cx("sk-group", s.key === "overdue" && "sk-overdue")} data-bucket={s.key}>
            <header className="sk-ghead">
              <H id={id} className={cx("sk-glabel", s.key === "overdue" && "text-danger")}>
                {cleared ? (
                  <span key="ring" aria-hidden="true" className={cx("sk-ring sk-ring-sm", recent(s.done, writes, t) && "sk-celebrate")}>
                    <CheckIcon className="h-2.5 w-2.5" />
                  </span>
                ) : null}
                {s.label}
              </H>
              {s.key === "overdue" || s.key === "later" ? (
                <span className="text-xs text-muted tabular-nums">{s.open.length}</span>
              ) : (
                <Progress done={s.done.length} total={total} label={s.label} />
              )}
            </header>
            {s.open.length ? (
              <ul className="jv-feed">
                {s.open.map((a) => (
                  <li key={a.id}>
                    <SkylightActionRow action={a} writable={writable} request={request} timezone={timezone} />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
      {compact && doneRows.length ? (
        <details className="sk-done-today group">
          <summary className="tap inline-flex items-center gap-1 rounded-[6px] px-1 text-xs font-medium text-muted hover:text-text">
            Done today <span className="tabular-nums">{doneRows.length}</span>
          </summary>
          <ul className="jv-feed mt-1" data-testid={`${idPrefix}-done`}>
            {doneRows.map((a) => (
              <li key={a.id}>
                <SkylightActionRow action={a} writable={writable} request={request} timezone={timezone} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
