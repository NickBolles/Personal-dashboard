"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog, Empty, ErrorNote, Field, Spinner, inputCls } from "@/components/ui";
import { Gantt, TimelineTable, type Zoom } from "@/components/work/Gantt";
import { WorkPageHeader, fmtDate, useWorkMutation } from "@/components/work/common";
import type { TimelineResponse, TimelineRow } from "@/lib/work";

export function TimelineView({ initialRoot }: { initialRoot?: string }) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [zoom, setZoom] = useState<Zoom>("week");
  const [table, setTable] = useState(false);
  const q = useQuery({
    queryKey: ["work", "timeline", root],
    queryFn: () => api.get<TimelineResponse>(`/api/work/timeline${root ? `?root=${encodeURIComponent(root)}` : ""}`),
  });
  const [editing, setEditing] = useState<TimelineRow | null>(null);
  const dates = useWorkMutation(
    (v: { id: string; startDate: string | null; targetDate: string | null }) =>
      api.patch(`/api/work/items/${encodeURIComponent(v.id)}`, { startDate: v.startDate, targetDate: v.targetDate }),
    { ok: "Dates saved" },
  );
  const choose = (id: string) => {
    setRoot(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("root", id);
    else url.searchParams.delete("root");
    window.history.replaceState(null, "", url);
  };
  return (
    <div className="min-w-0 px-3 py-3 sm:px-5 lg:px-6 lg:py-4">
      <WorkPageHeader
        eyebrow={`Plan vs. actual · ${q.data?.root ? q.data.root.title : "all areas"}`}
        title="Timeline"
        subtitle="Planned dates as bars; started, merged and settled markers come from what actually happened."
        actions={
          <>
            <div className="min-w-0">
              <label htmlFor="tl-root" className="sr-only">
                Area or project
              </label>
              <select id="tl-root" className={`${inputCls} min-w-44`} value={root} onChange={(e) => choose(e.target.value)}>
                <option value="">All areas</option>
                {q.data?.roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>
            <div role="group" aria-label="Zoom" className="flex gap-1">
              {(["week", "month"] as const).map((z) => (
                <Button key={z} size="sm" variant={zoom === z ? "primary" : "secondary"} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
                  {z === "week" ? "Weeks" : "Months"}
                </Button>
              ))}
            </div>
            <Button size="sm" aria-pressed={table} onClick={() => setTable((t) => !t)}>
              {table ? "Show chart" : "Show as table"}
            </Button>
          </>
        }
      />
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.isPending ? (
        <Spinner label="Loading timeline…" />
      ) : q.data && q.data.rows.length ? (
        <div className="min-w-0">
          <h2 className="sr-only">{q.data.root ? q.data.root.title : "All areas"}</h2>
          {table ? (
            <TimelineTable rows={q.data.rows} onEditDates={setEditing} />
          ) : (
            <Gantt rows={q.data.rows} today={q.data.today} zoom={zoom} dependencies={q.data.dependencies} onDates={(id, d) => dates.mutate({ id, ...d })} />
          )}
          {!table ? (
            <p className="mt-2 text-xs text-muted">
              Drag a bar to move it, or drag its ends to change the dates. To type dates instead, use Show as table → Edit dates.
            </p>
          ) : null}
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2.5 w-5 rounded border-[1.5px] border-accent bg-accent-soft" /> Planned (status colour)
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-accent" /> Started
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-[#6d4aff]" /> PR merged
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-ok" /> Settled
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-3 w-px bg-danger" /> Today
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2.5 w-5 rounded ring-2 ring-danger" /> Overdue
            </li>
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-px w-5 bg-muted" /> Depends on (arrow points to the waiting item)
            </li>
          </ul>
        </div>
      ) : (
        <Empty title="Nothing to plot">Add work items, then give them start and target dates.</Empty>
      )}
      {editing ? (
        <DatesDialog
          row={editing}
          busy={dates.isPending}
          onClose={() => setEditing(null)}
          onSave={(d) => dates.mutate({ id: editing.id, ...d }, { onSuccess: () => setEditing(null) })}
        />
      ) : null}
    </div>
  );
}

function DatesDialog({
  row,
  busy,
  onClose,
  onSave,
}: {
  row: TimelineRow;
  busy: boolean;
  onClose: () => void;
  onSave: (d: { startDate: string | null; targetDate: string | null }) => void;
}) {
  const [start, setStart] = useState(row.startDate ?? "");
  const [target, setTarget] = useState(row.targetDate ?? "");
  const invalid = !!start && !!target && target < start;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Dates for ${row.title}`}
      description={`Now: ${fmtDate(row.startDate)} to ${fmtDate(row.targetDate)}. Changes are recorded in the item's activity.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={invalid} onClick={() => onSave({ startDate: start || null, targetDate: target || null })}>
            Save dates
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="tl-start" label="Start date">
          <input id="tl-start" data-autofocus type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field id="tl-target" label="Target date" error={invalid ? "Target is before the start" : undefined}>
          <input id="tl-target" type="date" className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
