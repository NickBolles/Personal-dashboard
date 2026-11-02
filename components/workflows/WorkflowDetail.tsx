"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, ButtonLink, PageHeader, cx, useToast } from "@/components/ui";
import type { HistoryRow } from "@/lib/workflows/outputs";
import { WORKFLOW_START_EVENT } from "./events";

type Summary = { id: string; slug: string; name: string; description?: string; status: string };
type History = {
  rows: HistoryRow[];
  total: number;
  options: Record<"speaker" | "place" | "series" | "book", string[]>;
  stats: {
    total: number;
    perMonth: { month: string; count: number }[];
    topBooks: { label: string; count: number }[];
    topSpeakers: { label: string; count: number }[];
  };
};
type Reminder = { enabled: boolean; day: number; time: string; declared: boolean; unsupported?: string | null };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FILTERS = [
  ["speaker", "Speaker"],
  ["place", "Place"],
  ["series", "Series"],
  ["book", "Book"],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

/** Stats card (§12.10 #10): plain counts only — no streaks, badges, goals or scores. */
function StatsCard({ stats }: { stats: History["stats"] }) {
  const max = Math.max(1, ...stats.perMonth.map((p) => p.count));
  return (
    <section className="card min-w-0 p-3" aria-labelledby="wf-stats" data-testid="workflow-stats">
      <h2 id="wf-stats" className="font-semibold">
        Stats
      </h2>
      <p className="text-sm text-muted" data-dynamic>
        {stats.total === 1 ? "1 session" : `${stats.total} sessions`}
      </p>
      <h3 className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">Sessions per month</h3>
      <ol className="mt-1 grid grid-cols-12 items-end gap-1" aria-label="Sessions per month">
        {stats.perMonth.map((p) => (
          <li key={p.month} className="flex min-w-0 flex-col items-center gap-0.5 text-[10px]">
            <span>{p.count}</span>
            <span className="w-full rounded-sm bg-accent/60" style={{ height: `${Math.round((p.count / max) * 48) + 2}px` }} aria-hidden />
            <span className="truncate text-muted">{monthLabel(p.month)}</span>
            <span className="sr-only">
              {monthLabel(p.month)}: {p.count}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(
          [
            ["Top books", stats.topBooks],
            ["Top speakers", stats.topSpeakers],
          ] as const
        ).map(([label, list]) => (
          <div key={label} className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</h3>
            {list.length ? (
              <ul className="text-sm">
                {list.map((x) => (
                  <li key={x.label} className="flex min-w-0 justify-between gap-2">
                    <span className="min-w-0 truncate">{x.label}</span>
                    <span className="shrink-0 text-muted">{x.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">Nothing yet</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Session history (§12.10 #9): real table with filter chips; opens the session's chat. */
function SessionHistory({
  data,
  filter,
  setFilter,
}: {
  data: History;
  filter: Partial<Record<FilterKey, string>>;
  setFilter: (f: Partial<Record<FilterKey, string>>) => void;
}) {
  return (
    <section className="card min-w-0 p-3" aria-labelledby="wf-history" data-testid="workflow-history">
      <h2 id="wf-history" className="font-semibold">
        Session history
      </h2>
      <div className="mt-2 flex flex-col gap-2">
        {FILTERS.map(([k, label]) =>
          data.options[k].length ? (
            <div key={k} className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={`Filter by ${label.toLowerCase()}`}>
              <span className="text-xs text-muted">{label}</span>
              {data.options[k].map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={filter[k] === v}
                  onClick={() => setFilter({ ...filter, [k]: filter[k] === v ? undefined : v })}
                  className={cx(
                    "tap min-h-11 max-w-full truncate rounded-full border px-3 text-sm sm:min-h-9",
                    filter[k] === v ? "border-accent bg-accent/10 font-medium" : "border-line-strong",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          ) : null,
        )}
      </div>
      {data.rows.length ? (
        <div className="relative mt-2 overflow-x-auto">
          <table className="w-full min-w-0 text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Date
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Speaker
                </th>
                <th scope="col" className="hidden py-1 pr-2 font-medium sm:table-cell">
                  Place
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Passage
                </th>
                <th scope="col" className="hidden py-1 pr-2 font-medium sm:table-cell">
                  Notes
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {r.conversationId ? (
                      <Link className="underline" href={`/chat/${encodeURIComponent(r.conversationId)}`} aria-label={`Open session ${r.date}`}>
                        {r.date}
                      </Link>
                    ) : (
                      r.date
                    )}
                  </td>
                  <td className="py-1 pr-2 break-words">{r.speaker}</td>
                  <td className="hidden py-1 pr-2 break-words sm:table-cell">{r.place}</td>
                  <td className="py-1 pr-2 break-words">{r.scripture}</td>
                  <td className="hidden py-1 pr-2 text-muted sm:table-cell">{Object.values(r.counts).reduce((a, b) => a + b, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">{data.total ? "No sessions match these filters." : "No sessions yet."}</p>
      )}
    </section>
  );
}

/** D6: opt-in reminder. Sends a notification that opens the start form; never starts a model run. */
function ReminderCard({ workflowId, name }: { workflowId: string; name: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ["workflow-reminder", workflowId],
    queryFn: ({ signal }) => api.get<Reminder>(`/api/workflows/${workflowId}/reminder`, signal),
  });
  const r = q.data;
  // Latest tap wins: an older PUT answering after a newer tap must not flip the switch back.
  const seq = useRef(0);
  // React Query notifies observers on a later tick, so the controlled switch needs a synchronous
  // local value or React snaps it back for a frame (and Playwright's check() sees no change).
  const [pending, setPending] = useState<boolean | null>(null);
  const save = async (patch: Partial<Reminder>) => {
    if (!r) return;
    const n = ++seq.current;
    const k = ["workflow-reminder", workflowId];
    if (patch.enabled !== undefined) setPending(patch.enabled);
    qc.setQueryData(k, { ...r, ...patch }); // optimistic, so the switch flips on tap; reverted on error
    try {
      const next = await api.put<Reminder>(`/api/workflows/${workflowId}/reminder`, {
        enabled: patch.enabled ?? r.enabled,
        day: patch.day ?? r.day,
        time: patch.time ?? r.time,
      });
      if (n !== seq.current) return;
      qc.setQueryData(["workflow-reminder", workflowId], next);
      setPending(null);
      toast(next.enabled ? `Reminder on: ${DAYS[next.day]} ${next.time}` : "Reminder off", "ok");
    } catch (e) {
      if (n !== seq.current) return;
      qc.setQueryData(k, r);
      setPending(null);
      toast((e as Error).message, "danger");
    }
  };
  return (
    <section className="card min-w-0 p-3" aria-labelledby="wf-reminder" data-testid="workflow-reminder">
      <h2 id="wf-reminder" className="font-semibold">
        Reminder
      </h2>
      {r ? (
        <>
          <label className="mt-2 flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="h-5 w-5"
              checked={pending ?? r.enabled}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />
            <span>
              Remind me {DAYS[r.day]} at {r.time}
            </span>
          </label>
          <p className="text-xs text-muted">A notification asks “{name} — start?” and opens the start form. Nothing starts until you tap Start.</p>
          {r.unsupported ? (
            <p className="mt-1 text-xs text-muted" role="note" data-testid="reminder-unsupported">
              This workflow’s schedule (<code>{r.unsupported}</code>) isn’t one weekly time, so reminders can’t follow it. The reminder above uses {DAYS[r.day]}{" "}
              at {r.time} instead.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </section>
  );
}

export function WorkflowDetail({ slug }: { slug: string }) {
  const [filter, setFilter] = useState<Partial<Record<FilterKey, string>>>({});
  const list = useQuery({ queryKey: ["workflows"], queryFn: ({ signal }) => api.get<{ workflows: Summary[] }>("/api/workflows", signal) });
  const wf = list.data?.workflows.find((w) => w.slug === slug);
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const hist = useQuery({
    queryKey: ["workflow-history", wf?.id, qs],
    queryFn: ({ signal }) => api.get<History>(`/api/workflows/${wf!.id}/history${qs ? `?${qs}` : ""}`, signal),
    enabled: !!wf,
  });
  if (list.isLoading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (!wf)
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">Workflow not found</h1>
        <Link href="/workflows" className="underline">
          Back to workflows
        </Link>
      </div>
    );
  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 space-y-3 px-3 py-3 sm:px-6">
      <PageHeader
        title={wf.name}
        subtitle={wf.description}
        actions={
          <div className="flex flex-wrap gap-2">
            {wf.status === "active" ? (
              <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent(WORKFLOW_START_EVENT, { detail: { workflowId: wf.id } }))}>
                Start {wf.name}
              </Button>
            ) : null}
            <ButtonLink href={`/workflows/${wf.slug}/edit`}>Edit</ButtonLink>
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          {hist.data ? <SessionHistory data={hist.data} filter={filter} setFilter={setFilter} /> : <p className="text-sm text-muted">Loading…</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {hist.data ? <StatsCard stats={hist.data.stats} /> : null}
          <ReminderCard workflowId={wf.id} name={wf.name} />
        </div>
      </div>
    </div>
  );
}
