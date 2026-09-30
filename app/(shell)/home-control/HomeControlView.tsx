"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useSource } from "@/components/useSource";
import { SourceState } from "@/components/SourceState";
import { Badge, Button, Card, Dialog, ErrorNote, PageHeader, Spinner, cx, useNow, useOnline, useToast } from "@/components/ui";

type Control = {
  entityId: string;
  name: string;
  domain: string;
  state: string;
  lastChanged?: string;
  observedAt: string;
  stateToken: string;
  services: { service: string; label: string; wouldChange: boolean }[];
};

export function HomeControlView({ focusEntity }: { focusEntity?: string }) {
  const online = useOnline();
  const qc = useQueryClient();
  const { toast, announce } = useToast();
  const home = useSource("home_assistant");
  // Controls always use live state; refetch whenever we come back online.
  const controls = useQuery({
    queryKey: ["ha", "controls"],
    queryFn: () => api.get<{ controls: Control[]; fetchedAt: string }>("/api/home-assistant/controls"),
    enabled: online && home.data?.status.state !== "unconfigured" && home.data?.status.state !== "disabled",
    refetchInterval: 15_000,
    gcTime: 0,
  });
  useEffect(() => {
    if (online) controls.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const [confirm, setConfirm] = useState<{ control: Control; service: string; label: string }>();
  const [pendingId, setPendingId] = useState<string>();
  const exec = useMutation({
    mutationFn: (v: { control: Control; service: string }) =>
      api.post<{ verified: boolean; state: string; message: string }>("/api/home-assistant/control", {
        entityId: v.control.entityId,
        service: v.service,
        stateToken: v.control.stateToken,
        confirmed: true,
      }),
    onMutate: (v) => setPendingId(v.control.entityId),
    onSuccess: (r) => {
      toast(r.message, r.verified ? "ok" : "warn");
      announce(r.message);
    },
    onError: (e) => toast((e as Error).message, "danger"),
    onSettled: () => {
      setPendingId(undefined);
      qc.invalidateQueries({ queryKey: ["ha"] });
      qc.invalidateQueries({ queryKey: ["source", "home_assistant"] });
      qc.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const now = useNow(5_000);
  const exceptions = home.data?.data?.homeExceptions ?? [];
  const controlsFresh = controls.data && now - new Date(controls.data.fetchedAt).getTime() < 60_000;

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader title="Home" subtitle="Exceptions and a small set of confirmed controls." />
      {home.isLoading ? <Spinner label="Loading home state…" /> : null}
      <SourceState status={home.data?.status} hasData={Boolean(home.data?.data)} />

      {home.data?.data ? (
        <section aria-labelledby="ex-h" className="mt-4">
          <h2 id="ex-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
            Exceptions
          </h2>
          {exceptions.length ? (
            <ul className="space-y-2">
              {exceptions.map((e) => (
                <li key={e.entityId} className={cx("card p-3", focusEntity === e.entityId && "border-accent")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={e.severity === "critical" || e.severity === "high" ? "danger" : e.severity === "normal" ? "warn" : "neutral"}>
                      {e.severity}
                    </Badge>
                    <span className="font-medium">{e.name}</span>
                  </div>
                  <p className="text-sm text-muted">
                    {e.reason} · state “{e.state}”{e.since ? ` since ${new Date(e.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nothing unusual in your watched entities.</p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="ctl-h" className="mt-6">
        <h2 id="ctl-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Controls
        </h2>
        {!online ? (
          <p role="status" className="rounded-xl bg-warn-soft p-3 text-sm text-warn">
            Controls are disabled while offline. Jarvis never queues physical actions; they’ll re-enable after a fresh state check.
          </p>
        ) : null}
        {controls.error ? <ErrorNote error={controls.error} retry={() => controls.refetch()} /> : null}
        {controls.isLoading ? <Spinner label="Reading live state…" /> : null}
        {controls.data && !controls.data.controls.length ? (
          <p className="text-sm text-muted">No controls allowlisted. Add some in Settings → Connections → Home Assistant.</p>
        ) : null}
        <ul className="grid gap-2 sm:grid-cols-2">
          {(controls.data?.controls ?? []).map((c) => (
            <li key={c.entityId}>
              <Card className={cx(focusEntity === c.entityId && "border-accent")}>
                <p className="font-medium">{c.name}</p>
                <p className="text-sm text-muted">
                  Now: <strong className="text-text">{c.state}</strong>
                  <span className="block text-xs">Checked {new Date(c.observedAt).toLocaleTimeString()}</span>
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.services.map((s) => (
                    <Button
                      key={s.service}
                      size="sm"
                      variant={s.wouldChange ? "primary" : "secondary"}
                      disabled={!online || !controlsFresh || c.state === "missing" || pendingId === c.entityId}
                      busy={pendingId === c.entityId && exec.variables?.service === s.service}
                      onClick={() => setConfirm({ control: c, service: s.service, label: s.label })}
                      aria-label={`${s.label} ${c.name}`}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
                {pendingId === c.entityId ? (
                  <p className="mt-2 text-xs text-muted" role="status">
                    Waiting for Home Assistant to confirm…
                  </p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(undefined)}
        title={confirm ? `${confirm.label} ${confirm.control.name}?` : ""}
        description={
          confirm ? (
            <>
              Current state: <strong>{confirm.control.state}</strong> (checked {new Date(confirm.control.observedAt).toLocaleTimeString()}). If it changed since
              then, Jarvis will stop and ask again.
            </>
          ) : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(undefined)} data-autofocus>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirm) exec.mutate({ control: confirm.control, service: confirm.service });
                setConfirm(undefined);
              }}
            >
              Yes, {confirm?.label.toLowerCase()}
            </Button>
          </>
        }
      />
    </div>
  );
}
