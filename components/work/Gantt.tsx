"use client";

import Link from "next/link";
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { addDays, daysBetween } from "@/lib/time";
import { cx } from "@/components/ui";
import { shiftDates, STATUS_LABELS, todayIso, type TimelineDependency, type TimelineRow } from "@/lib/work";
import { STATUS_FILL, StatusBadge, StatusDot, fmtDate } from "./common";

export type Zoom = "week" | "month";
const PX: Record<Zoom, number> = { week: 28, month: 8 };
const ACTUAL: Record<TimelineRow["actuals"][number]["kind"], { label: string; cls: string }> = {
  started: { label: "Started", cls: "bg-accent" },
  merged: { label: "PR merged", cls: "bg-[#6d4aff]" },
  settled: { label: "Settled", cls: "bg-ok" },
};

const localDay = (at: string) => todayIso(new Date(at));

function range(rows: TimelineRow[], today: string) {
  const dates = [today];
  for (const r of rows) {
    if (r.startDate) dates.push(r.startDate);
    if (r.targetDate) dates.push(r.targetDate);
    for (const a of r.actuals) dates.push(localDay(a.at));
  }
  dates.sort();
  let start = addDays(dates[0]!, -3);
  let end = addDays(dates.at(-1)!, 7);
  if (daysBetween(start, end) < 28) end = addDays(start, 28);
  // Start on a Monday so week ticks line up.
  const dow = new Date(`${start}T12:00:00Z`).getUTCDay();
  start = addDays(start, -((dow + 6) % 7));
  return { start, days: daysBetween(start, end) + 1 };
}

function ticks(start: string, days: number, zoom: Zoom) {
  const out: { day: number; label: string }[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const dt = new Date(`${date}T12:00:00Z`);
    if (zoom === "week" ? dt.getUTCDay() === 1 : dt.getUTCDate() === 1)
      out.push({ day: d, label: dt.toLocaleDateString("en-US", { month: "short", day: zoom === "week" ? "numeric" : undefined, timeZone: "UTC" }) });
  }
  return out;
}

const ROW_H = 33; // h-8 row + 1px border
const HEAD_H = 33; // h-8 header + 1px border

/** Bars: a status-coloured hairline with a soft fill (artifact `.bar.*`). */
const BAR_CLS: Record<TimelineRow["status"], string> = {
  captured: "border-dashed border-line-strong bg-surface",
  exploring: "border-dashed border-line-strong bg-surface",
  ready: "border-dashed border-accent bg-surface",
  in_progress: "border-accent bg-accent-soft",
  in_review: "border-[var(--violet)] bg-[var(--violet-soft)]",
  awaiting_validation: "border-warn bg-warn-soft",
  ready_to_settle: "border-ok bg-ok-soft",
  settled: "border-ok bg-ok-soft",
  reopened: "border-danger bg-danger-soft",
  on_hold: "border-line-strong bg-surface-2 opacity-60",
  superseded: "border-line-strong bg-surface-2 opacity-60",
  abandoned: "border-line-strong bg-surface-2 opacity-60",
};

type DragMode = "move" | "start" | "end";
type BarDrag = { id: string; mode: DragMode; x: number; days: number };

/**
 * Plain CSS Gantt: planned bars (start→target), actual markers from events,
 * today line and dependency connectors (blocker's end → dependent's start).
 * With `onDates`, bars can be dragged (pointer) to move them or their ends,
 * snapped to days; the accessible alternative is "Edit dates" in the table.
 */
export function Gantt({
  rows,
  today,
  zoom,
  compact,
  dependencies = [],
  onDates,
}: {
  rows: TimelineRow[];
  today: string;
  zoom: Zoom;
  compact?: boolean;
  dependencies?: TimelineDependency[];
  onDates?: (id: string, d: { startDate: string | null; targetDate: string | null }) => void;
}) {
  const [drag, setDrag] = useState<BarDrag | null>(null);
  const { start, days } = range(rows, today);
  const px = PX[zoom];
  const width = days * px;
  const x = (date: string) => daysBetween(start, date) * px;
  // Narrower on phones so the chart keeps most of the width.
  const labelW = compact ? "9rem" : "clamp(8.5rem, 30vw, 15rem)";
  const dated = (r: TimelineRow) => (drag && drag.id === r.id ? { ...r, ...shiftDates(r, drag.mode, drag.days) } : r);
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const bar = (r: TimelineRow) => {
    const d = dated(r);
    const s = d.startDate ?? d.targetDate;
    const e = d.targetDate ?? d.startDate;
    if (!s || !e) return null;
    return { left: x(s), right: x(e) + px, both: !!(d.startDate && d.targetDate) };
  };
  const startDrag = (r: TimelineRow, e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onDates || e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const off = e.clientX - rect.left;
    const mode: DragMode = r.startDate && r.targetDate && rect.width > 20 ? (off < 8 ? "start" : off > rect.width - 8 ? "end" : "move") : "move";
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    setDrag({ id: r.id, mode, x: e.clientX, days: 0 });
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const n = Math.round((e.clientX - drag.x) / px);
    if (n !== drag.days) setDrag({ ...drag, days: n });
  };
  const endDrag = (r: TimelineRow) => {
    if (!drag || drag.id !== r.id) return;
    const next = shiftDates(r, drag.mode, drag.days);
    setDrag(null);
    if (onDates && (next.startDate !== r.startDate || next.targetDate !== r.targetDate)) onDates(r.id, next);
  };
  return (
    <div data-scroll-x className="max-w-full overflow-x-auto rounded-[10px] border border-line bg-surface">
      <div className="relative" style={{ width: `calc(${labelW} + ${width}px)`, minWidth: "100%" }}>
        <div className="flex border-b border-line bg-surface text-[11.5px] text-muted">
          <div className="wk-label sticky left-0 z-20 flex h-8 shrink-0 items-center border-r border-line bg-surface px-2.5" style={{ width: labelW }}>
            Item
          </div>
          <div className="relative h-8" style={{ width }}>
            {ticks(start, days, zoom).map((t) => (
              <span
                key={t.day}
                className="absolute top-0 flex h-8 items-center border-l border-line pl-1 whitespace-nowrap tabular-nums"
                style={{ left: t.day * px }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
        <ul>
          {rows.map((r) => {
            const d = dated(r);
            const b = bar(r);
            const desc = [
              d.startDate || d.targetDate ? `planned ${fmtDate(d.startDate)} to ${fmtDate(d.targetDate)}` : "no planned dates",
              STATUS_LABELS[r.status],
              r.overdue ? "overdue" : "",
              r.validationOverdue ? "validation overdue" : "",
              r.blocked ? "blocked by unfinished work" : "",
              ...r.actuals.map((a) => `${ACTUAL[a.kind].label} ${fmtDate(localDay(a.at))}`),
            ]
              .filter(Boolean)
              .join(", ");
            return (
              <li key={r.id} className={cx("flex border-b border-line last:border-b-0", r.depth === 0 && "bg-surface-2")} data-row={r.id}>
                <div
                  className={cx("sticky left-0 z-10 flex h-8 shrink-0 items-center border-r border-line px-2.5", r.depth === 0 ? "bg-surface-2" : "bg-surface")}
                  style={{ width: labelW }}
                >
                  <Link
                    href={`/areas?item=${encodeURIComponent(r.id)}`}
                    className={cx("flex min-w-0 items-center gap-1.5 text-[13px] hover:underline", r.depth === 0 && "font-semibold")}
                    style={{ paddingLeft: `${Math.min(r.depth, 6) * 12}px` }}
                    aria-label={`${r.title}: ${desc}`}
                  >
                    {r.depth === 0 ? null : <StatusDot status={r.status} />}
                    <span className="truncate">{r.title}</span>
                  </Link>
                </div>
                <div className="relative h-8" style={{ width }} aria-hidden="true">
                  {b ? (
                    <div
                      title={onDates ? `${desc}. Drag to move; drag an end to change that date.` : desc}
                      data-bar={r.id}
                      onPointerDown={(e) => startDrag(r, e)}
                      onPointerMove={moveDrag}
                      onPointerUp={() => endDrag(r)}
                      onPointerCancel={() => setDrag(null)}
                      className={cx(
                        "absolute top-1.5 h-5 overflow-hidden rounded-md",
                        b.both ? cx("border-[1.5px]", BAR_CLS[r.status]) : cx("w-3 rotate-45", STATUS_FILL[r.status]),
                        r.overdue && "ring-2 ring-danger ring-offset-1 ring-offset-[var(--surface)]",
                        onDates && "cursor-grab touch-none active:cursor-grabbing",
                        drag?.id === r.id && "opacity-60 ring-2 ring-accent",
                      )}
                      style={b.both ? { left: b.left, width: Math.max(px, b.right - b.left) } : { left: b.left + px / 2 - 6, width: 12, height: 12, top: 10 }}
                    >
                      {b.both && !compact && b.right - b.left > 60 ? (
                        <span className="pointer-events-none block truncate px-2 text-[11px] leading-[17px] text-text">{r.title}</span>
                      ) : null}
                      {onDates && b.both ? (
                        <>
                          <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
                          <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {r.validationOverdue ? (
                    <span className="absolute top-1.5 right-1 rounded bg-warn-soft px-1 text-[10px] font-semibold text-warn" title="Validation overdue">
                      !
                    </span>
                  ) : null}
                  {r.actuals.map((a, i) => (
                    <span
                      key={`${a.kind}-${i}`}
                      title={`${ACTUAL[a.kind].label} ${fmtDate(localDay(a.at))}`}
                      className={cx("pointer-events-none absolute top-[11px] h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)]", ACTUAL[a.kind].cls)}
                      style={{ left: x(localDay(a.at)) + px / 2 - 5 }}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        {dependencies.length ? (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute z-[5] overflow-visible text-muted"
            style={{ left: labelW, top: HEAD_H, width, height: rows.length * ROW_H }}
            data-connectors={dependencies.length}
          >
            <defs>
              <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            {dependencies.map((dep) => {
              const fi = index.get(dep.from);
              const ti = index.get(dep.to);
              const fb = fi !== undefined ? bar(rows[fi]!) : null;
              const tb = ti !== undefined ? bar(rows[ti]!) : null;
              if (fi === undefined || ti === undefined || !fb || !tb) return null;
              const x1 = fb.right;
              const y1 = fi * ROW_H + ROW_H / 2;
              const x2 = tb.left;
              const y2 = ti * ROW_H + ROW_H / 2;
              const mid = Math.max(x1 + 8, Math.min(x2 - 8, (x1 + x2) / 2));
              return (
                <path
                  key={dep.id}
                  d={`M${x1},${y1} H${mid} V${y2} H${x2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={x2 < x1 ? "4 3" : undefined}
                  markerEnd="url(#dep-arrow)"
                />
              );
            })}
          </svg>
        ) : null}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 z-[6] w-px bg-danger"
          style={{ left: `calc(${labelW} + ${x(today) + px / 2}px)` }}
        >
          {!compact ? <span className="absolute top-0.5 left-1 text-[10.5px] font-bold text-danger">Today</span> : null}
        </div>
      </div>
    </div>
  );
}

export function TimelineTable({ rows, onEditDates }: { rows: TimelineRow[]; onEditDates?: (r: TimelineRow) => void }) {
  return (
    // relative: keeps absolutely positioned descendants (sr-only text) inside the scroll box.
    <div data-scroll-x className="relative overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <caption className="sr-only">Work timeline</caption>
        <thead className="wk-label">
          <tr>
            <th scope="col" className="px-2.5 py-1.5">
              Item
            </th>
            <th scope="col" className="px-2.5 py-1.5">
              Status
            </th>
            <th scope="col" className="px-2.5 py-1.5">
              Start
            </th>
            <th scope="col" className="px-2.5 py-1.5">
              Target
            </th>
            <th scope="col" className="px-2.5 py-1.5">
              Actual
            </th>
            {onEditDates ? (
              <th scope="col" className="px-2.5 py-1.5">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <th scope="row" className="px-2.5 py-1.5 font-normal">
                <Link href={`/areas?item=${encodeURIComponent(r.id)}`} className="hover:underline" style={{ paddingLeft: `${Math.min(r.depth, 6) * 10}px` }}>
                  {r.title}
                </Link>
                {r.overdue ? <span className="ml-2 text-xs font-medium text-danger">Overdue</span> : null}
                {r.validationOverdue ? <span className="ml-2 text-xs font-medium text-warn">Validation overdue</span> : null}
                {r.blocked ? <span className="ml-2 text-xs font-medium text-muted">Blocked</span> : null}
              </th>
              <td className="px-2.5 py-1.5">
                <StatusBadge status={r.status} />
              </td>
              <td className="px-2.5 py-1.5">{fmtDate(r.startDate)}</td>
              <td className="px-2.5 py-1.5">{fmtDate(r.targetDate)}</td>
              <td className="px-2.5 py-1.5">{r.actuals.map((a) => `${ACTUAL[a.kind].label} ${fmtDate(localDay(a.at))}`).join("; ") || "—"}</td>
              {onEditDates ? (
                <td className="px-2.5 py-1.5">
                  <button type="button" className="tap min-h-11 rounded-lg px-2 text-accent underline" onClick={() => onEditDates(r)}>
                    Edit dates<span className="sr-only"> for {r.title}</span>
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
