"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/client/api";
import type { CompassState } from "@/integrations/types";
import { Badge, Button, ButtonLink, Card, Empty, ErrorNote, PageHeader, Spinner, useOnline, useToast } from "@/components/ui";

export function CompassView() {
  const router = useRouter();
  const qc = useQueryClient();
  const online = useOnline();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ["compass"],
    queryFn: () => api.get<{ enabled: boolean; mode: string; reminderTime: string; state: CompassState }>("/api/daily-compass"),
  });
  const start = useMutation({
    mutationFn: () => api.post<{ sessionId: string; runId?: string }>("/api/daily-compass/start"),
    onSuccess: (r) => router.push(`/chat/${encodeURIComponent(r.sessionId)}${r.runId ? `?run=${encodeURIComponent(r.runId)}` : ""}`),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const complete = useMutation({
    mutationFn: () => api.post("/api/daily-compass/complete"),
    onSuccess: () => {
      toast("Check-in complete", "ok");
      qc.invalidateQueries({ queryKey: ["compass"] });
      qc.invalidateQueries({ queryKey: ["home"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const s = q.data?.state;
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader title="Daily Compass" subtitle={s ? `Today · window ${s.windowStart}–${s.windowEnd}` : undefined} />
      {q.isLoading ? <Spinner label="Loading…" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data && !q.data.enabled ? (
        <Empty
          title="Daily Compass isn’t set up"
          action={
            <Link className="underline" href="/settings/connections">
              Set it up
            </Link>
          }
        />
      ) : null}
      {s && q.data?.enabled ? (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            {s.completed ? <Badge tone="ok">Completed</Badge> : s.inWindow ? <Badge tone="accent">Window open</Badge> : <Badge>Window closed</Badge>}
            <span className="text-sm text-muted">Reminder at {q.data.reminderTime}</span>
          </div>
          <p className="mt-3">
            {s.completed
              ? `Done for today${s.completedAt ? ` at ${new Date(s.completedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Nice.`
              : "A short conversation with Hermes to close out the day: how it went, what mattered, and tomorrow’s one thing."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {q.data.mode === "http" && s.url ? (
              <ButtonLink href={s.url} external variant="primary">
                Open Daily Compass
              </ButtonLink>
            ) : (
              <Button variant="primary" busy={start.isPending} disabled={!online} onClick={() => start.mutate()}>
                {s.sessionId ? "Continue check-in" : "Start check-in with Hermes"}
              </Button>
            )}
            {!s.completed ? (
              <Button busy={complete.isPending} disabled={!online} onClick={() => complete.mutate()}>
                Mark complete
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
