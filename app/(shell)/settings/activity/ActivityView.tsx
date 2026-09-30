"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, ErrorNote, PageHeader, Spinner } from "@/components/ui";

type Entry = { id: string; at: string; actor: string; action: string; source?: string; sourceRecord?: string; result: string; correlationId: string; detail?: string };

export function ActivityView() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ entries: Entry[] }>("/api/audit") });
  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
      <PageHeader title="Activity log" subtitle="Consequential actions with their upstream result and correlation ID." />
      {q.isLoading ? <Spinner label="Loading…" /> : null}
      {q.error ? <ErrorNote error={q.error} /> : null}
      <ul className="card divide-y divide-line">
        {(q.data?.entries ?? []).map((e) => (
          <li key={e.id} className="p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={e.result === "ok" ? "ok" : e.result === "pending" ? "warn" : "danger"}>{e.result}</Badge>
              <span className="font-mono">{e.action}</span>
              {e.sourceRecord ? <span className="truncate text-muted">{e.sourceRecord}</span> : null}
            </div>
            <p className="mt-1 text-xs text-muted">
              {new Date(e.at).toLocaleString()} · <span className="font-mono">{e.correlationId.slice(0, 8)}</span>
            </p>
            {e.detail ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted">{e.detail}</pre> : null}
          </li>
        ))}
        {q.data && !q.data.entries.length ? <li className="p-3 text-sm text-muted">Nothing yet.</li> : null}
      </ul>
    </div>
  );
}
