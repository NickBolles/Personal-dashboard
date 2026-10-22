"use client";

import Link from "next/link";
import { addDays, daysBetween } from "@/lib/time";
import { cx } from "@/components/ui";
import { STATUS_LABELS, todayIso, type TimelineRow } from "@/lib/work";
import { STATUS_FILL, StatusBadge, fmtDate } from "./common";

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

/** Plain CSS Gantt: planned bars (start→target), actual markers from events, today line. */
export function Gantt({ rows, today, zoom, compact }: { rows: TimelineRow[]; today: string; zoom: Zoom; compact?: boolean }) {
  const { start, days } = range(rows, today);
  const px = PX[zoom];
  const width = days * px;
  const x = (date: string) => daysBetween(start, date) * px;
  const labelW = compact ? "8rem" : "11rem";
  return (
    <div data-scroll-x className="max-w-full overflow-x-auto rounded-lg border border-line">
      <div className="relative" style={{ width: `calc(${labelW} + ${width}px)`, minWidth: "100%" }}>
        <div className="flex border-b border-line bg-surface-2 text-xs text-muted">
          <div className="sticky left-0 z-20 shrink-0 bg-surface-2 px-2 py-1 font-medium" style={{ width: labelW }}>
            Item
          </div>
          <div className="relative h-7" style={{ width }}>
            {ticks(start, days, zoom).map((t) => (
              <span key={t.day} className="absolute top-1 border-l border-line pl-1 whitespace-nowrap" style={{ left: t.day * px }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>
        <ul>
          {rows.map((r) => {
            const s = r.startDate ?? r.targetDate;
            const e = r.targetDate ?? r.startDate;
            const desc = [
              r.startDate || r.targetDate ? `planned ${fmtDate(r.startDate)} to ${fmtDate(r.targetDate)}` : "no planned dates",
              STATUS_LABELS[r.status],
              r.overdue ? "overdue" : "",
              r.validationOverdue ? "validation overdue" : "",
              ...r.actuals.map((a) => `${ACTUAL[a.kind].label} ${fmtDate(localDay(a.at))}`),
            ]
              .filter(Boolean)
              .join(", ");
            return (
              <li key={r.id} className="flex border-b border-line last:border-b-0" data-row={r.id}>
                <div className="sticky left-0 z-10 shrink-0 bg-surface px-2 py-1.5" style={{ width: labelW }}>
                  <Link
                    href={`/work?item=${encodeURIComponent(r.id)}`}
                    className="block truncate text-sm hover:underline"
                    style={{ paddingLeft: `${Math.min(r.depth, 6) * 10}px` }}
                    aria-label={`${r.title}: ${desc}`}
                  >
                    {r.title}
                  </Link>
                </div>
                <div className="relative h-9" style={{ width }} aria-hidden="true">
                  {s && e ? (
                    <div
                      title={desc}
                      className={cx(
                        "absolute top-2 h-5 rounded",
                        STATUS_FILL[r.status],
                        r.overdue && "ring-2 ring-danger ring-offset-1 ring-offset-[var(--surface)]",
                        r.startDate && r.targetDate ? "opacity-80" : "w-3 rotate-45",
                      )}
                      style={
                        r.startDate && r.targetDate
                          ? { left: x(s), width: Math.max(px, (daysBetween(s, e) + 1) * px) }
                          : { left: x(s) + px / 2 - 6, width: 12, height: 12, top: 12 }
                      }
                    />
                  ) : null}
                  {r.validationOverdue ? (
                    <span className="absolute top-1 right-1 rounded bg-warn-soft px-1 text-[10px] font-semibold text-warn" title="Validation overdue">
                      !
                    </span>
                  ) : null}
                  {r.actuals.map((a, i) => (
                    <span
                      key={`${a.kind}-${i}`}
                      title={`${ACTUAL[a.kind].label} ${fmtDate(localDay(a.at))}`}
                      className={cx("absolute top-3.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)]", ACTUAL[a.kind].cls)}
                      style={{ left: x(localDay(a.at)) + px / 2 - 5 }}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 z-0 w-px bg-danger"
          style={{ left: `calc(${labelW} + ${x(today) + px / 2}px)` }}
        />
      </div>
    </div>
  );
}

export function TimelineTable({ rows }: { rows: TimelineRow[] }) {
  return (
    <div data-scroll-x className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Work timeline</caption>
        <thead className="text-xs text-muted">
          <tr>
            <th scope="col" className="p-2">
              Item
            </th>
            <th scope="col" className="p-2">
              Status
            </th>
            <th scope="col" className="p-2">
              Start
            </th>
            <th scope="col" className="p-2">
              Target
            </th>
            <th scope="col" className="p-2">
              Actual
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <th scope="row" className="p-2 font-normal">
                <Link href={`/work?item=${encodeURIComponent(r.id)}`} className="hover:underline" style={{ paddingLeft: `${Math.min(r.depth, 6) * 10}px` }}>
                  {r.title}
                </Link>
                {r.overdue ? <span className="ml-2 text-xs font-medium text-danger">Overdue</span> : null}
                {r.validationOverdue ? <span className="ml-2 text-xs font-medium text-warn">Validation overdue</span> : null}
              </th>
              <td className="p-2">
                <StatusBadge status={r.status} />
              </td>
              <td className="p-2">{fmtDate(r.startDate)}</td>
              <td className="p-2">{fmtDate(r.targetDate)}</td>
              <td className="p-2">{r.actuals.map((a) => `${ACTUAL[a.kind].label} ${fmtDate(localDay(a.at))}`).join("; ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
