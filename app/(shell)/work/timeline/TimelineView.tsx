"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Card, Empty, ErrorNote, Field, PageHeader, Spinner, inputCls } from "@/components/ui";
import { Gantt, TimelineTable, type Zoom } from "@/components/work/Gantt";
import type { TimelineResponse } from "@/lib/work";

export function TimelineView({ initialRoot }: { initialRoot?: string }) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [zoom, setZoom] = useState<Zoom>("week");
  const [table, setTable] = useState(false);
  const q = useQuery({
    queryKey: ["work", "timeline", root],
    queryFn: () => api.get<TimelineResponse>(`/api/work/timeline${root ? `?root=${encodeURIComponent(root)}` : ""}`),
  });
  const choose = (id: string) => {
    setRoot(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("root", id);
    else url.searchParams.delete("root");
    window.history.replaceState(null, "", url);
  };
  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <PageHeader title="Timeline" subtitle="Planned dates as bars; started, merged and settled markers come from what actually happened." />
      <Card className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <Field id="tl-root" label="Area or project">
            <select id="tl-root" className={inputCls} value={root} onChange={(e) => choose(e.target.value)}>
              <option value="">All areas</option>
              {q.data?.roots.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </Field>
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
      </Card>
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.isPending ? (
        <Spinner label="Loading timeline…" />
      ) : q.data && q.data.rows.length ? (
        <Card className="p-2 sm:p-3">
          <h2 className="sr-only">{q.data.root ? q.data.root.title : "All areas"}</h2>
          {table ? <TimelineTable rows={q.data.rows} /> : <Gantt rows={q.data.rows} today={q.data.today} zoom={zoom} />}
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="inline-block h-2.5 w-5 rounded bg-accent opacity-80" /> Planned (status colour)
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
          </ul>
        </Card>
      ) : (
        <Empty title="Nothing to plot">Add work items, then give them start and target dates.</Empty>
      )}
    </div>
  );
}
