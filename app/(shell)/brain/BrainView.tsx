"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { Badge, Button, ButtonLink, Card, ErrorNote, PageHeader, Spinner, useOnline, useToast } from "@/components/ui";

type Settled<T> = { ok: true; items: T[] } | { ok: false; error: string };
type Job = { id: string; name: string; schedule_display?: string; enabled?: boolean; state?: string; next_run_at?: string; last_run_at?: string; last_status?: string; last_error?: string; failure_streak?: number };
type Brain = {
  health: { ok: boolean; value?: { version?: string; status: string }; error?: string };
  memoryWriteApi: boolean;
  skills: Settled<{ name: string; description?: string; category?: string }>;
  toolsets: Settled<{ name: string; label?: string; enabled?: boolean; configured?: boolean; tools?: string[] }>;
  jobs: Settled<Job>;
  dashboardUrl?: string;
};

export function BrainView() {
  const online = useOnline();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["brain"], queryFn: () => api.get<Brain>("/api/brain") });
  const job = useMutation({
    mutationFn: (v: { id: string; op: "pause" | "resume" | "run" }) => api.post(`/api/hermes/jobs/${v.id}/${v.op}`),
    onSuccess: (_r, v) => {
      toast(v.op === "run" ? "Job triggered" : v.op === "pause" ? "Job paused" : "Job resumed", "ok");
      qc.invalidateQueries({ queryKey: ["brain"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const d = q.data;
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Brain"
        subtitle="Hermes status, skills, tools and scheduled jobs."
        actions={d?.dashboardUrl ? <ButtonLink href={d.dashboardUrl} external>Operator dashboard</ButtonLink> : null}
      />
      {q.isLoading ? <Spinner label="Loading…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {d ? (
        <div className="space-y-4">
          <Card>
            <h2 className="font-semibold">Status</h2>
            {d.health.ok ? (
              <p className="mt-1 text-sm">
                <Badge tone="ok">Online</Badge> <span className="text-muted">{d.health.value?.version}</span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-danger">Unreachable: {d.health.error}</p>
            )}
            <p className="mt-2 text-sm text-muted">
              Memory: Hermes keeps MEMORY.md and USER.md on the server. {d.memoryWriteApi ? "This Hermes exposes a memory API." : "The API server doesn’t expose memory contents, so view or edit them in the operator dashboard."}
            </p>
          </Card>

          <Card>
            <h2 className="font-semibold">Scheduled jobs</h2>
            {!d.jobs.ok ? (
              <p className="mt-1 text-sm text-muted">Not available: {d.jobs.error}</p>
            ) : d.jobs.items.length ? (
              <ul className="mt-2 divide-y divide-line">
                {d.jobs.items.map((j) => (
                  <li key={j.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{j.name}</span>
                      <Badge tone={j.state === "paused" || j.enabled === false ? "neutral" : "accent"}>{j.state ?? (j.enabled ? "scheduled" : "disabled")}</Badge>
                      {j.last_status === "error" || (j.failure_streak ?? 0) > 0 ? <Badge tone="danger">Failing ×{j.failure_streak ?? 1}</Badge> : null}
                    </div>
                    <p className="text-sm text-muted">
                      {j.schedule_display}
                      {j.next_run_at ? ` · next ${relativeTime(j.next_run_at)}` : ""}
                      {j.last_run_at ? ` · last ${relativeTime(j.last_run_at)}` : ""}
                    </p>
                    {j.last_error ? <p className="text-sm text-danger">{j.last_error}</p> : null}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" disabled={!online} onClick={() => job.mutate({ id: j.id, op: "run" })}>
                        Run now
                      </Button>
                      {j.state === "paused" ? (
                        <Button size="sm" disabled={!online} onClick={() => job.mutate({ id: j.id, op: "resume" })}>
                          Resume
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={!online} onClick={() => job.mutate({ id: j.id, op: "pause" })}>
                          Pause
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">No scheduled jobs.</p>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold">Skills</h2>
            {d.skills.ok ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {d.skills.items.map((s) => (
                  <li key={s.name}>
                    <Badge>{s.name}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Not available: {d.skills.error}</p>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold">Toolsets</h2>
            {d.toolsets.ok ? (
              <ul className="mt-2 space-y-1 text-sm">
                {d.toolsets.items.map((t) => (
                  <li key={t.name}>
                    <span className="font-medium">{t.label ?? t.name}</span> <span className="text-muted">{t.enabled ? "enabled" : "disabled"}{t.configured === false ? " · not configured" : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Not available: {d.toolsets.error}</p>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
