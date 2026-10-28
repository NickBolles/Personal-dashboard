"use client";

import Link from "next/link";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ComponentRenderProps } from "@json-render/react";
import type { ComponentName, PropsOf } from "@/lib/jarvis-ui/catalog";
import { blockFits, blockMoveIntent, chipIntent, DAY_END, DAY_START, fmtMinutes, weekDays, type BriefChoice, type Intent } from "@/lib/jarvis-ui/intents";
import { calendarRef } from "@/lib/jarvis-ui/validator";
import type { AppliedEntry, HydratedRef } from "@/lib/jarvis-ui/types";
import { addDays, daysBetween } from "@/lib/time";
import { Badge, Button, ButtonLink, OverflowMenu, cx, type MenuItem } from "@/components/ui";
import { InlineText, useSurface } from "./context";

type P<N extends ComponentName> = ComponentRenderProps<PropsOf<N>>;
type Hyd<K extends string> = Extract<HydratedRef, { kind: K }>;

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtUsd = (v: number) => `$${v.toFixed(2)}`;
const canUndo = (e: AppliedEntry) => (e.undo as { type?: string } | undefined)?.type !== "none";

function hyd<K extends "metric" | "calendar" | "pr" | "todo" | "item">(h: HydratedRef | undefined, kind: K | K[]): Hyd<K> | undefined {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return h && "kind" in h && (kinds as string[]).includes(h.kind) ? (h as Hyd<K>) : undefined;
}

function unavailableText(h: HydratedRef | undefined, hydrating: boolean) {
  if (hydrating && !h) return "Loading…";
  if (h && "unavailable" in h) return h.message ?? (h.unavailable === "finance" ? "Finance is never shown to AI" : "Not available");
  return "Not available";
}

function DuePill({ due, today }: { due?: string; today: string }) {
  if (!due) return null;
  const late = daysBetween(due, today);
  if (late > 0) return <Badge tone="danger">{late === 1 ? "1 day late" : `${late} days late`}</Badge>;
  return <Badge tone={late === 0 ? "warn" : "neutral"}>{late === 0 ? "Today" : fmtDay(due)}</Badge>;
}

// --- metrics ---

function metricValue(m: Hyd<"metric">) {
  if (m.value == null) return "—";
  return m.unit === "usd" ? fmtUsd(m.value) : String(m.value);
}

export function MetricGauge({ metric, label }: { metric: string; label?: string }) {
  const s = useSurface();
  const m = hyd(s.refs[metric], "metric");
  const name = label ?? m?.label ?? "Metric";
  if (!m) {
    return (
      <div className="min-w-[9rem] flex-1 rounded-[10px] border border-line px-3 py-2">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">{name}</p>
        <p className="text-xs text-muted">{unavailableText(s.refs[metric], s.hydrating)}</p>
      </div>
    );
  }
  const max = m.max ?? 0;
  const pct = max > 0 && m.value != null ? Math.max(0, Math.min(1, m.value / max)) : 0;
  const tone = pct >= 0.9 ? "bg-danger" : pct >= 0.7 ? "bg-warn" : "bg-ok";
  return (
    <div className="min-w-[9rem] flex-1 rounded-[10px] border border-line px-3 py-2" data-metric={metric}>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{name}</p>
      <p className="text-lg font-bold tabular-nums" data-dynamic>
        {metricValue(m)}
        {max ? <span className="text-xs font-medium text-muted"> / {m.unit === "usd" ? fmtUsd(max) : max}</span> : null}
      </p>
      {max ? (
        <div
          role="meter"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={m.value ?? 0}
          aria-valuetext={`${metricValue(m)} of ${m.unit === "usd" ? fmtUsd(max) : max}`}
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div className={cx("h-full", tone)} style={{ width: `${pct * 100}%` }} />
        </div>
      ) : null}
      <p className="mt-1 text-xs text-muted">
        {m.href ? (
          <Link href={m.href} className="underline">
            {m.note}
          </Link>
        ) : (
          m.note
        )}
      </p>
    </div>
  );
}

export function Sparkline({ element }: P<"Sparkline">) {
  const s = useSurface();
  const ref = element.props.metric;
  const m = hyd(s.refs[ref], "metric");
  const name = element.props.label ?? m?.label ?? "Trend";
  const series = m?.series ?? [];
  const w = 120;
  const h = 28;
  const max = Math.max(1e-9, ...series.map((x) => x.value));
  const pts = series.map((x, i) => `${((i / Math.max(1, series.length - 1)) * w).toFixed(1)},${(h - 2 - (x.value / max) * (h - 4)).toFixed(1)}`).join(" ");
  const fmt = (v: number) => (m?.unit === "usd" ? fmtUsd(v) : String(v));
  return (
    <div className="min-w-[9rem] flex-1 rounded-[10px] border border-line px-3 py-2" data-metric={ref}>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{name}</p>
      {m && series.length ? (
        <>
          <p className="text-lg font-bold tabular-nums" data-dynamic>
            {metricValue(m)}
          </p>
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            role="img"
            aria-label={`${name}: ${series.map((x) => `${x.label} ${fmt(x.value)}`).join(", ")}`}
            className="mt-0.5 max-w-full text-accent"
          >
            <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
          </svg>
          <p className="text-xs text-muted">{m.note}</p>
        </>
      ) : (
        <p className="text-xs text-muted">{unavailableText(s.refs[ref], s.hydrating)}</p>
      )}
    </div>
  );
}

// --- daily brief rows ---

const CHIPS: { id: BriefChoice; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "snooze", label: "Snooze" },
  { id: "skip", label: "Skip" },
];

function BriefRow({ row }: { row: PropsOf<"ApprovalChips">["rows"][number] }) {
  const s = useSurface();
  const h = hyd(s.refs[row.ref], ["todo", "item"]);
  const name = h?.title ?? unavailableText(s.refs[row.ref], s.hydrating);
  const staged = s.staged.get(row.ref);
  const applied = s.applied.get(row.ref);
  const skipped = s.skips.includes(row.ref);
  const tomorrow = addDays(s.today, 1);
  const choiceOf = (i: Intent | undefined): BriefChoice | undefined => {
    const d = i?.kind === "todo.snooze" ? i.date : i?.kind === "item.update" ? i.patch.targetDate : undefined;
    return d === s.today ? "today" : d === tomorrow ? "snooze" : undefined;
  };
  const chosen = skipped ? "skip" : choiceOf(staged);
  return (
    <li
      className={cx("smart-row flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-3 py-2", (skipped || applied) && "opacity-70")}
      data-ref={row.ref}
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className={cx("truncate font-medium", skipped && "line-through")}>{name}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-dynamic>
          {h ? <DuePill due={h.due} today={s.today} /> : null}
          {h?.where ? <span>{h.where}</span> : null}
          {row.reason ? (
            <span className="min-w-0 truncate">
              · <InlineText text={row.reason} />
            </span>
          ) : null}
        </div>
        {s.errors.get(row.ref) ? (
          <p role="alert" className="mt-0.5 text-xs text-danger">
            {s.errors.get(row.ref)}
          </p>
        ) : null}
      </div>
      {s.readOnly || !h ? null : applied ? (
        <span className="flex shrink-0 items-center gap-1 text-xs">
          <span className="text-ok">✓ {applied.message}</span>
          {canUndo(applied) ? (
            <Button size="sm" variant="ghost" busy={s.undoing === applied.intentHash} onClick={() => s.undo(applied)} aria-label={`Undo: ${name}`}>
              Undo
            </Button>
          ) : null}
        </span>
      ) : (
        <span role="group" aria-label={`Plan for ${name}`} className="seg shrink-0">
          {CHIPS.map((c) => {
            const intent = chipIntent(row.ref, c.id, s.today, h.due);
            const noop = c.id !== "skip" && !intent;
            return (
              <button
                key={c.id}
                type="button"
                className="seg-item"
                aria-pressed={chosen === c.id}
                disabled={noop}
                title={noop ? (c.id === "today" ? "Already due today" : "Already due tomorrow") : undefined}
                aria-label={`${c.label}: ${name}`}
                onClick={() => {
                  if (c.id === "skip") {
                    if (staged) s.stage(row.ref, undefined);
                    s.toggleSkip(row.ref);
                    return;
                  }
                  if (skipped) s.toggleSkip(row.ref);
                  s.stage(row.ref, chosen === c.id ? undefined : intent);
                }}
              >
                {c.label}
              </button>
            );
          })}
        </span>
      )}
    </li>
  );
}

export function ApprovalChips({ element }: P<"ApprovalChips">) {
  const p = element.props;
  return (
    <section className="overflow-hidden rounded-[10px] border border-line" aria-label={p.title}>
      <header className="flex items-center gap-2 bg-surface-2 px-3 py-1.5">
        <h3 className="flex-1 text-sm font-semibold">
          {p.title} <span className="text-muted">{p.rows.length}</span>
        </h3>
        <span className="text-xs text-muted">Today / Snooze stage a date · Skip only hides it here</span>
      </header>
      <ul>
        {p.rows.map((r) => (
          <BriefRow key={r.ref} row={r} />
        ))}
      </ul>
    </section>
  );
}

// --- week plan ---

type Pos = { day: string | null; start?: string };
const PX_PER_MIN = 0.7;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const GRID_START = toMin(DAY_START);
const GRID_END = toMin(DAY_END);
const CAPACITY_MIN = 6 * 60;

export function WeekPlan({ element }: P<"WeekPlan">) {
  const p = element.props;
  const s = useSurface();
  const days = weekDays(p.weekOf, p.days ?? 5);
  const plannable = days.filter((d) => d >= s.today);
  const cal = hyd(s.refs[calendarRef(p.weekOf, p.days ?? 5)], "calendar");
  const saved = (s.uiState.blocks ?? {}) as Record<string, Pos>;
  const pos = (b: (typeof p.blocks)[number]): Pos => saved[b.ref] ?? { day: b.day && b.day >= s.today ? b.day : null, start: b.start };
  const [drag, setDrag] = useState<{ ref: string; x: number; y: number; dy: number; w: number; h: number; over?: string | null } | null>(null);
  const dragStart = useRef<{ ref: string; x: number; y: number; dy: number; w: number; h: number } | null>(null);

  const dueOf = (ref: string) => hyd(s.refs[ref], ["todo", "item"])?.due;
  const titleOf = (ref: string) => hyd(s.refs[ref], ["todo", "item"])?.title;
  const startFor = (day: string, minutes: number, exclude: string) => {
    // after the last block already on that day (or 09:00), staying inside the grid
    const ends = p.blocks.filter((b) => b.ref !== exclude && pos(b).day === day && pos(b).start).map((b) => toMin(pos(b).start!) + b.minutes);
    const t = Math.max(toMin("09:00"), ...ends);
    return toHHMM(Math.min(t, GRID_END - minutes));
  };

  /** Move a block: saves its position (surface state) and stages the date change when the day differs from its live due date. */
  const move = (b: (typeof p.blocks)[number], day: string | null, start?: string) => {
    if (s.readOnly) return;
    const st = day ? (start && blockFits(start, b.minutes) ? start : startFor(day, b.minutes, b.ref)) : undefined;
    s.patchState({ blocks: { ...saved, [b.ref]: { day, ...(st ? { start: st } : {}) } } });
    const due = dueOf(b.ref);
    s.stage(b.ref, day && day !== due ? blockMoveIntent(b.ref, day) : undefined);
    const calKey = `cal:${b.ref}`;
    if (s.staged.has(calKey)) s.stage(calKey, day && st ? { kind: "calendar.block", ref: b.ref, date: day, start: st, minutes: b.minutes } : undefined);
  };

  const pending = p.blocks.filter((b) => {
    const d = pos(b).day;
    return d && hyd(s.refs[b.ref], ["todo", "item"]) && d !== dueOf(b.ref) && !s.staged.has(b.ref) && !s.applied.get(b.ref);
  });
  const calCandidates = p.blocks.filter(
    (b) => pos(b).day && pos(b).start && hyd(s.refs[b.ref], ["todo", "item"]) && !s.staged.has(`cal:${b.ref}`) && !s.applied.get(`cal:${b.ref}`),
  );

  const fixedMin = (d: string) =>
    (cal?.events ?? [])
      .filter((e) => e.day === d && !e.allDay && e.start)
      .reduce((n, e) => n + Math.max(15, (e.end ? toMin(e.end) : toMin(e.start!) + 60) - toMin(e.start!)), 0);
  const blockMin = (d: string) => p.blocks.filter((b) => pos(b).day === d).reduce((n, b) => n + b.minutes, 0);
  const scheduled = p.blocks.filter((b) => pos(b).day);
  const totalMin = scheduled.reduce((n, b) => n + b.minutes, 0);
  const capacity = plannable.length * CAPACITY_MIN;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, ref: string) => {
    if (s.readOnly || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const r = e.currentTarget.getBoundingClientRect();
    dragStart.current = { ref, x: e.clientX, y: e.clientY, dy: e.clientY - r.top, w: r.width, h: r.height };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const dropTarget = (x: number, y: number) => {
    const el = document.elementsFromPoint(x, y).find((n) => (n as HTMLElement).dataset?.planDay !== undefined) as HTMLElement | undefined;
    return el ? { day: el.dataset.planDay || null, top: el.getBoundingClientRect().top } : undefined;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = dragStart.current;
    if (!st) return;
    if (!drag && Math.hypot(e.clientX - st.x, e.clientY - st.y) < 5) return;
    setDrag({ ...st, x: e.clientX, y: e.clientY, over: dropTarget(e.clientX, e.clientY)?.day });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = dragStart.current;
    dragStart.current = null;
    if (!st || !drag) return setDrag(null);
    setDrag(null);
    const t = dropTarget(e.clientX, e.clientY);
    const b = p.blocks.find((x) => x.ref === st.ref);
    if (!t || !b) return;
    if (t.day && !plannable.includes(t.day)) return;
    const raw = GRID_START + (e.clientY - st.dy - t.top) / PX_PER_MIN;
    const start = Math.max(GRID_START, Math.min(GRID_END - b.minutes, Math.round(raw / 15) * 15));
    move(b, t.day, t.day ? toHHMM(start) : undefined);
  };

  const blockCard = (b: (typeof p.blocks)[number], inGrid: boolean) => {
    const h = hyd(s.refs[b.ref], ["todo", "item"]);
    const name = h?.title ?? unavailableText(s.refs[b.ref], s.hydrating);
    const at = pos(b);
    const staged = s.staged.get(b.ref);
    const applied = s.applied.get(b.ref);
    const calStaged = s.staged.has(`cal:${b.ref}`);
    const calApplied = s.applied.get(`cal:${b.ref}`);
    const due = h?.due;
    const proposed = at.day && due !== at.day && !staged && !applied;
    const items: MenuItem[] = [];
    if (h && !s.readOnly) {
      for (const d of plannable) if (d !== at.day) items.push({ label: `Move to ${fmtDay(d)}`, onSelect: () => move(b, d) });
      if (at.day && at.start) {
        const st = toMin(at.start);
        if (st - 30 >= GRID_START) items.push({ label: "30 min earlier", onSelect: () => move(b, at.day, toHHMM(st - 30)) });
        if (st + 30 + b.minutes <= GRID_END) items.push({ label: "30 min later", onSelect: () => move(b, at.day, toHHMM(st + 30)) });
      }
      if (at.day) items.push({ label: "Unschedule", onSelect: () => move(b, null) });
      if (cal?.writable && at.day && at.start && !calApplied)
        items.push(
          calStaged
            ? { label: "Don’t add to calendar", onSelect: () => s.stage(`cal:${b.ref}`, undefined) }
            : {
                label: "Add to calendar…",
                onSelect: () => s.stage(`cal:${b.ref}`, { kind: "calendar.block", ref: b.ref, date: at.day!, start: at.start!, minutes: b.minutes }),
              },
        );
      if (applied && canUndo(applied)) items.push({ label: "Undo date change", onSelect: () => s.undo(applied) });
    }
    const top = inGrid && at.start ? (toMin(at.start) - GRID_START) * PX_PER_MIN : undefined;
    return (
      <div
        key={b.ref}
        data-ref={b.ref}
        data-testid="plan-block"
        role="group"
        aria-label={`${name}${at.day ? `, ${fmtDay(at.day)}${at.start ? ` ${at.start}` : ""}` : ", unscheduled"}, ${fmtMinutes(b.minutes)}`}
        onPointerDown={(e) => onPointerDown(e, b.ref)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragStart.current = null;
          setDrag(null);
        }}
        className={cx(
          "flex touch-none items-start gap-1 overflow-hidden rounded-[7px] border px-1.5 py-1 text-xs select-none",
          inGrid ? "absolute right-1 left-1" : "w-44",
          staged ? "border-accent bg-accent-soft" : proposed ? "border-dashed border-accent/70 bg-surface" : "border-line-strong bg-surface-2",
          drag?.ref === b.ref && "opacity-30",
          !s.readOnly && h && "cursor-grab",
        )}
        style={inGrid ? { top, height: Math.max(22, b.minutes * PX_PER_MIN - 2) } : undefined}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-muted" data-dynamic>
            {at.start ? `${at.start} · ` : ""}
            {fmtMinutes(b.minutes)}
            {applied ? " · ✓ moved" : staged ? " · staged" : proposed && due ? ` · due ${fmtDay(due)}` : ""}
            {calStaged ? " · +calendar" : calApplied ? " · ✓ calendar" : ""}
          </span>
        </span>
        {items.length ? <OverflowMenu label={`Plan options for ${name}`} items={items} /> : null}
      </div>
    );
  };

  const unscheduled = p.blocks.filter((b) => !pos(b).day);
  const ghost = drag ? p.blocks.find((b) => b.ref === drag.ref) : undefined;
  return (
    <section className="overflow-hidden rounded-[10px] border border-line" aria-label={p.title ?? `Week of ${fmtDay(p.weekOf)}`} data-testid="week-plan">
      <header className="flex flex-wrap items-center gap-2 bg-surface-2 px-3 py-1.5">
        <h3 className="flex-1 text-sm font-semibold">{p.title ?? `Week of ${fmtDay(p.weekOf)}`}</h3>
        <span className="text-xs text-muted" data-dynamic>
          {scheduled.length} scheduled · {Math.round((totalMin / 60) * 10) / 10} h of {capacity / 60} h
        </span>
        {!s.readOnly && pending.length ? (
          <Button size="sm" variant="ghost" onClick={() => pending.forEach((b) => s.stage(b.ref, blockMoveIntent(b.ref, pos(b).day!)))}>
            Accept plan ({pending.length} {pending.length === 1 ? "move" : "moves"})
          </Button>
        ) : null}
        {!s.readOnly && cal?.writable && calCandidates.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              calCandidates.forEach((b) =>
                s.stage(`cal:${b.ref}`, { kind: "calendar.block", ref: b.ref, date: pos(b).day!, start: pos(b).start!, minutes: b.minutes }),
              )
            }
          >
            Add all to calendar…
          </Button>
        ) : null}
      </header>
      <div
        role="meter"
        aria-label="Planned hours this week"
        aria-valuemin={0}
        aria-valuemax={capacity / 60}
        aria-valuenow={Math.round((totalMin / 60) * 10) / 10}
        className="mx-3 my-1.5 h-1.5 overflow-hidden rounded-full bg-surface"
      >
        <div className={cx("h-full", totalMin > capacity ? "bg-warn" : "bg-ok")} style={{ width: `${Math.min(1, totalMin / Math.max(1, capacity)) * 100}%` }} />
      </div>
      <div className="relative">
        <div className="overflow-x-auto">
          <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `2.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map((d) => {
              const load = fixedMin(d) + blockMin(d);
              return (
                <div key={d} className={cx("border-b border-l border-line px-1.5 py-1 text-xs", d < s.today && "text-muted")}>
                  <span className="font-semibold">{fmtDay(d)}</span>
                  <span className={cx("block tabular-nums", load > CAPACITY_MIN ? "font-semibold text-warn" : "text-muted")} data-dynamic>
                    {Math.round((load / 60) * 10) / 10} h{load > CAPACITY_MIN ? " · over" : ""}
                  </span>
                  {(cal?.events ?? [])
                    .filter((e) => e.day === d && e.allDay)
                    .map((e) => (
                      <span key={e.id} className="mt-0.5 block truncate rounded border border-dashed border-line-strong px-1 text-muted">
                        {e.title}
                      </span>
                    ))}
                </div>
              );
            })}
            <div className="relative" style={{ height: (GRID_END - GRID_START) * PX_PER_MIN }} aria-hidden="true">
              {Array.from({ length: (GRID_END - GRID_START) / 60 }, (_, i) => (
                <span key={i} className="absolute right-1 text-[10px] text-muted" style={{ top: i * 60 * PX_PER_MIN }}>
                  {((GRID_START / 60 + i + 11) % 12) + 1}
                  {GRID_START / 60 + i >= 12 ? "p" : "a"}
                </span>
              ))}
            </div>
            {days.map((d) => (
              <div
                key={d}
                data-plan-day={plannable.includes(d) ? d : undefined}
                aria-label={`${fmtDay(d)} column`}
                className={cx("relative border-l border-line", d < s.today && "bg-surface-2/60", drag?.over === d && "bg-accent-soft/40")}
                style={{
                  height: (GRID_END - GRID_START) * PX_PER_MIN,
                  backgroundImage: "linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
                  backgroundSize: `100% ${60 * PX_PER_MIN}px`,
                }}
              >
                {(cal?.events ?? [])
                  .filter((e) => e.day === d && !e.allDay && e.start)
                  .map((e) => {
                    const st = Math.max(GRID_START, toMin(e.start!));
                    const en = Math.min(GRID_END, e.end ? toMin(e.end) : st + 60);
                    if (en <= GRID_START || st >= GRID_END) return null;
                    return (
                      <div
                        key={e.id}
                        className="absolute right-1 left-1 overflow-hidden rounded-[7px] border border-dashed border-line-strong bg-surface px-1.5 py-0.5 text-xs text-muted"
                        style={{ top: (st - GRID_START) * PX_PER_MIN, height: Math.max(18, (en - st) * PX_PER_MIN - 2) }}
                        data-testid="plan-fixed"
                      >
                        <span className="block truncate">{e.title}</span>
                        <span className="block">
                          {e.start}
                          {e.end ? `–${e.end}` : ""} · calendar
                        </span>
                      </div>
                    );
                  })}
                {p.blocks.filter((b) => pos(b).day === d && pos(b).start).map((b) => blockCard(b, true))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        data-plan-day=""
        aria-label="Unscheduled"
        className={cx("flex min-h-12 flex-wrap items-start gap-1.5 border-t border-line px-3 py-2", drag?.over === null && "bg-accent-soft/40")}
      >
        <span className="self-center text-xs text-muted">Unscheduled{unscheduled.length ? ` (${unscheduled.length})` : ""}:</span>
        {unscheduled.map((b) => blockCard(b, false))}
        {/* blocks with a day but no time (from a reply) sit here until placed */}
        {p.blocks.filter((b) => pos(b).day && !pos(b).start).map((b) => blockCard(b, false))}
      </div>
      <p className="px-3 pb-2 text-xs text-muted">
        Drag a block (or use ⋯) to another day: that stages a new due/target date. Calendar events are read-only
        {cal?.writable ? "; adding a block to the calendar needs its own approval." : "."}
      </p>
      {ghost && drag ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded-[7px] border border-accent bg-accent-soft px-1.5 py-1 text-xs shadow-lg"
          style={{ left: drag.x - drag.w / 2, top: drag.y - drag.dy, width: drag.w, height: drag.h }}
        >
          {titleOf(ghost.ref) ?? ""}
        </div>
      ) : null}
    </section>
  );
}

// --- PR review card ---

const CHECK_ICON = { pass: "✓", fail: "✕", pending: "●", skipped: "–" } as const;
const CHECK_TONE = { pass: "text-ok", fail: "text-danger", pending: "text-warn", skipped: "text-muted" } as const;

export function PRCard({ element }: P<"PRCard">) {
  const s = useSurface();
  const ref = element.props.ref;
  const pr = hyd(s.refs[ref], "pr");
  const [all, setAll] = useState(false);
  if (!pr) {
    return (
      <section className="rounded-[10px] border border-line px-3 py-2" aria-label="Pull request">
        <p className="font-medium">{ref.slice(3)}</p>
        <p className="text-xs text-muted">{unavailableText(s.refs[ref], s.hydrating)}</p>
      </section>
    );
  }
  const r = pr.readiness;
  const open = pr.state === "open";
  const shown = all ? pr.checks : pr.checks.slice(0, 6);
  return (
    <section className="overflow-hidden rounded-[10px] border border-line" aria-label={`Pull request #${pr.number}: ${pr.title}`} data-testid="pr-card">
      <header className="flex flex-wrap items-center gap-2 bg-surface-2 px-3 py-1.5">
        <h3 className="min-w-0 flex-1 text-sm font-semibold">
          #{pr.number} {pr.title}
        </h3>
        {open ? (
          r.blockers.length ? (
            <Badge tone="warn">
              {r.blockers.length} {r.blockers.length === 1 ? "blocker" : "blockers"}
            </Badge>
          ) : (
            <Badge tone="ok">Ready to merge</Badge>
          )
        ) : (
          <Badge tone={pr.state === "merged" ? "ok" : "neutral"}>{pr.state}</Badge>
        )}
      </header>
      <p className="px-3 pt-1.5 text-xs text-muted" data-dynamic>
        {pr.repo}
        {pr.headRef ? ` · ${pr.headRef} → ${pr.baseRef ?? "main"}` : ""}
        {pr.additions != null ? ` · +${pr.additions} −${pr.deletions ?? 0}` : ""}
        {pr.files != null ? ` · ${pr.files} files` : ""}
        {pr.draft ? " · draft" : ""}
      </p>
      {open ? (
        <div className="px-3 pt-1.5">
          <div
            role="meter"
            aria-label="Merge readiness"
            aria-valuemin={0}
            aria-valuemax={r.total}
            aria-valuenow={r.done}
            aria-valuetext={`${r.done} of ${r.total} ready`}
            className="flex gap-1"
          >
            {Array.from({ length: r.total }, (_, i) => (
              <span key={i} className={cx("h-1.5 flex-1 rounded-full", i < r.done ? "bg-ok" : "bg-surface-2")} />
            ))}
          </div>
          <p className="mt-1 text-xs" data-testid="pr-readiness">
            Merge readiness {r.done}/{r.total}
            {r.blockers.length ? ` · ${r.blockers.join(" · ")}` : " · everything GitHub checks is green"}
          </p>
        </div>
      ) : null}
      <ul className="mt-1.5" aria-label="Checks">
        {shown.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex items-center gap-2 border-t border-line px-3 py-1 text-sm">
            <span aria-hidden="true" className={cx("w-4 text-center font-bold", CHECK_TONE[c.state])}>
              {CHECK_ICON[c.state]}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className={cx("text-xs", CHECK_TONE[c.state])}>{c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : c.state}</span>
          </li>
        ))}
        {!pr.checks.length ? <li className="border-t border-line px-3 py-1 text-xs text-muted">No checks reported for the head commit.</li> : null}
      </ul>
      {pr.checks.length > 6 ? (
        <Button size="sm" variant="ghost" className="mx-2" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Fewer checks" : `All ${pr.checks.length} checks`}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-1.5 text-xs">
        <span className="text-muted">Reviews:</span>
        {pr.reviews.length ? (
          pr.reviews.map((rv) => (
            <Badge key={rv.who} tone={rv.state === "approved" ? "ok" : rv.state === "changes_requested" ? "danger" : "neutral"}>
              {rv.who} · {rv.state === "approved" ? "approved" : rv.state === "changes_requested" ? "changes requested" : "commented"}
            </Badge>
          ))
        ) : (
          <span>none yet</span>
        )}
        {pr.codexFindings != null ? (
          <span className="ml-auto" data-testid="pr-codex">
            Codex findings: {pr.codexFindings}
          </span>
        ) : null}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-line-strong px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted">{open ? "Merging happens on GitHub. Jarvis never merges." : "Read from GitHub just now."}</p>
        {pr.itemHref ? (
          <Link href={pr.itemHref} className="tap inline-flex items-center px-1 text-[13px] text-accent hover:underline">
            Open item
          </Link>
        ) : null}
        <ButtonLink href={pr.url} external size="sm">
          {open ? "Open on GitHub to merge ↗" : "Open on GitHub ↗"}
        </ButtonLink>
      </footer>
    </section>
  );
}
