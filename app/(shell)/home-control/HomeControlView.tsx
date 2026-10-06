"use client";

import { useAccess } from "@/components/access";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { CalendarEvent, HomeHealth, SourceStatus } from "@/lib/contracts";
import type { DeviceView } from "@/integrations/home-assistant/devices";
import { CameraIcon, LightIcon } from "@/components/icons";
import { useSource } from "@/components/useSource";
import { SourceState } from "@/components/SourceState";
import { Badge, Button, ButtonLink, Card, Dialog, ErrorNote, PageHeader, Spinner, cx, useNow, useOnline, useToast } from "@/components/ui";

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
  const { can } = useAccess();
  const qc = useQueryClient();
  const { toast, announce } = useToast();
  const home = useSource("home_assistant");
  // Controls always use live state; refetch whenever we come back online.
  const controls = useQuery({
    queryKey: ["ha", "controls"],
    queryFn: () => api.get<{ controls: Control[]; fetchedAt: string }>("/api/home-assistant/controls"),
    enabled:
      online &&
      (can("home_assistant.control_doors") || can("home_assistant.control_lights")) &&
      home.data?.status.state !== "unconfigured" &&
      home.data?.status.state !== "disabled",
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
      <PageHeader
        title="Home"
        subtitle={
          can("home_assistant.view") ? "Exceptions, doors, lights and cameras. Physical controls are confirmed and read back." : "The household calendar."
        }
        actions={
          home.data?.data && can("hermes.chat") ? (
            <ButtonLink href={`/chat?new=1&context=${encodeURIComponent(homeContext(home.data.data, controls.data?.controls))}`}>
              Ask Hermes about my home
            </ButtonLink>
          ) : null
        }
      />
      {home.isLoading ? <Spinner label="Loading home state…" /> : null}
      <SourceState status={home.data?.status} hasData={Boolean(home.data?.data)} />

      {can("home_assistant.calendar") && home.data?.data?.events?.length ? <CalendarSection events={home.data.data.events} /> : null}

      {home.data?.data && can("home_assistant.view") ? (
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

      {can("home_assistant.view") || can("home_assistant.cameras") ? <Devices focusEntity={focusEntity} online={online} /> : null}

      {can("home_assistant.view") && home.data?.status && home.data.status.state !== "unconfigured" && home.data.status.state !== "disabled" ? (
        <HealthPanel status={home.data.status} health={home.data.data?.extra?.health as HomeHealth | undefined} />
      ) : null}

      {can("home_assistant.control_doors") ? (
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
      ) : null}

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

function CalendarSection({ events }: { events: CalendarEvent[] }) {
  return (
    <section aria-labelledby="cal-h" className="mt-4">
      <h2 id="cal-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Household calendar
      </h2>
      <ul className="card divide-y divide-line">
        {events.slice(0, 10).map((e) => (
          <li key={e.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
            <span className="font-medium">{e.title}</span>
            <span className="text-muted" data-dynamic>
              {e.allDay
                ? new Date(`${e.startsAt.slice(0, 10)}T12:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
                : new Date(e.startsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
              {e.location ? ` · ${e.location}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Devices = { fetchedAt: string; lightControl: string; doors: DeviceView[]; lights: DeviceView[]; cameras: DeviceView[] };

const KIND_LABEL: Record<DeviceView["kind"], string> = {
  lock: "Lock",
  garage: "Garage",
  door: "Door",
  window: "Window",
  cover: "Cover",
  light: "Light",
  camera: "Camera",
};

function Devices({ focusEntity, online }: { focusEntity?: string; online: boolean }) {
  const qc = useQueryClient();
  const { toast, announce } = useToast();
  const { can } = useAccess();
  const q = useQuery({
    queryKey: ["ha", "devices"],
    queryFn: () => api.get<Devices>("/api/home-assistant/devices"),
    enabled: online,
    refetchInterval: 15_000,
    gcTime: 0,
  });
  const light = useMutation({
    mutationFn: (v: { entityId: string; on: boolean }) => api.post<{ verified: boolean; message: string }>("/api/home-assistant/lights", v),
    onSuccess: (r) => {
      toast(r.message, r.verified ? "ok" : "warn");
      announce(r.message);
    },
    onError: (e) => toast((e as Error).message, "danger"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["ha"] }),
  });
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return q.isLoading ? <Spinner label="Reading devices…" /> : null;
  const d = q.data;
  return (
    <>
      {d.doors.length ? (
        <section aria-labelledby="doors-h" className="mt-6">
          <h2 id="doors-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
            Doors, locks and garage
          </h2>
          <ul className="card divide-y divide-line">
            {d.doors.map((x) => (
              <li key={x.entityId} className={cx("flex flex-wrap items-center justify-between gap-2 p-3", focusEntity === x.entityId && "bg-accent-soft")}>
                <span>
                  <span className="font-medium">{x.name}</span> <span className="text-xs text-muted">{KIND_LABEL[x.kind]}</span>
                </span>
                <Badge tone={["open", "unlocked", "on", "opening"].includes(x.state) ? "warn" : x.state === "unavailable" ? "neutral" : "ok"}>
                  {x.kind === "door" || x.kind === "window" ? (x.state === "on" ? "open" : x.state === "off" ? "closed" : x.state) : x.state}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {d.lights.length ? (
        <section aria-labelledby="lights-h" className="mt-6">
          <h2 id="lights-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
            Lights
          </h2>
          {!online ? <p className="mb-2 text-sm text-warn">Light switches are off while offline.</p> : null}
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.lights.map((x) => {
              const on = x.state === "on";
              const canSwitch = can("home_assistant.control_lights") && x.services.length > 0;
              const busy = light.isPending && light.variables?.entityId === x.entityId;
              return (
                <li key={x.entityId} className={cx("card flex items-center justify-between gap-3 p-3", focusEntity === x.entityId && "border-accent")}>
                  <span className="flex items-center gap-2">
                    <LightIcon className={cx("h-6 w-6", on ? "text-warn" : "text-muted")} />
                    <span>
                      <span className="block font-medium">{x.name}</span>
                      <span className="text-xs text-muted">
                        {x.state}
                        {x.brightness !== undefined ? ` · ${x.brightness}%` : ""}
                      </span>
                    </span>
                  </span>
                  {canSwitch ? (
                    <Button
                      size="sm"
                      aria-pressed={on}
                      aria-label={`${x.name}: ${on ? "on, turn off" : "off, turn on"}`}
                      disabled={!online || x.state === "unavailable" || busy}
                      busy={busy}
                      onClick={() => light.mutate({ entityId: x.entityId, on: !on })}
                    >
                      {on ? "Turn off" : "Turn on"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {d.cameras.length ? (
        <section aria-labelledby="cams-h" className="mt-6">
          <h2 id="cams-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
            Cameras
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {d.cameras.map((c) => (
              <CameraCard key={c.entityId} camera={c} online={online} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** Loads a still only when asked (and again on refresh). Images are never cached. */
function CameraCard({ camera, online }: { camera: DeviceView; online: boolean }) {
  const [shot, setShot] = useState<{ at: number; failed?: boolean }>();
  return (
    <li className="card overflow-hidden p-0">
      {shot && !shot.failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- live, uncached still from our API
        <img
          src={`/api/home-assistant/cameras/${encodeURIComponent(camera.entityId)}?t=${shot.at}`}
          alt={`${camera.name}, still taken at ${new Date(shot.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
          className="aspect-video w-full bg-surface-2 object-cover"
          onError={() => setShot({ ...shot, failed: true })}
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center bg-surface-2 text-muted">
          <CameraIcon className="h-8 w-8" />
          {shot?.failed ? <span className="ml-2 text-sm">Couldn’t load the image</span> : null}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 p-3">
        <span>
          <span className="block font-medium">{camera.name}</span>
          <span className="text-xs text-muted">{camera.state}</span>
        </span>
        <Button size="sm" disabled={!online} onClick={() => setShot({ at: Date.now() })}>
          {shot ? "Refresh" : "Show image"}
        </Button>
      </div>
    </li>
  );
}

/**
 * Counts only. Anything Jarvis couldn't read is "unknown", never 0. When the
 * last read failed, every count is unknown rather than a reassuring old number.
 */
function HealthPanel({ status, health }: { status: SourceStatus; health?: HomeHealth }) {
  const readable = status.state === "ok" || status.state === "stale";
  const h = readable ? health : undefined;
  const value = (n: number | undefined) => (n === undefined ? "unknown" : String(n));
  const rows: { label: string; value: string; warn: boolean; note?: string }[] = [
    { label: "Entities", value: value(h?.entities), warn: false },
    { label: "Unavailable", value: value(h?.unavailable), warn: Boolean(h?.unavailable) },
    { label: "Unknown state", value: value(h?.unknown), warn: false },
    {
      label: "Updates pending",
      value: value(h?.updatesPending),
      warn: Boolean(h?.updatesPending),
      note: h && h.updatesPending === undefined ? "No update entities exposed" : undefined,
    },
    {
      label: "Integrations failing",
      value: value(h?.integrationsFailing),
      warn: Boolean(h?.integrationsFailing),
      note: h && h.integrationsFailing === undefined ? "Needs an admin token to read" : h?.failingDomains?.length ? h.failingDomains.join(", ") : undefined,
    },
  ];
  return (
    <section aria-labelledby="health-h" className="mt-6">
      <h2 id="health-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Home Assistant health
      </h2>
      <Card as="div">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="min-w-0">
              <dt className="text-xs text-muted">{r.label}</dt>
              <dd className={cx("text-lg font-semibold tabular-nums", r.value === "unknown" && "text-base font-medium text-muted", r.warn && "text-warn")}>
                {r.value}
              </dd>
              {r.note ? <dd className="text-xs text-muted [overflow-wrap:anywhere]">{r.note}</dd> : null}
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted" data-dynamic>
          {h
            ? `Read ${new Date(h.checkedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
            : readable
              ? "Home Assistant hasn’t reported health yet."
              : "Can’t read Home Assistant right now, so these are unknown."}
        </p>
      </Card>
    </section>
  );
}

/** What Jarvis currently sees at home, as plain text context for a Hermes conversation. */
function homeContext(
  data: { homeExceptions?: { entityId: string; name: string; state: string; reason: string; since?: string }[]; extra?: Record<string, unknown> },
  controls: Control[] | undefined,
) {
  const time = (t?: string) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
  const lines = [`Home Assistant snapshot from Jarvis at ${time(new Date().toISOString())}:`];
  const ex = data.homeExceptions ?? [];
  lines.push(ex.length ? "Exceptions:" : "Exceptions: none in watched entities.");
  for (const e of ex) lines.push(`- ${e.name} (${e.entityId}): ${e.reason}, state "${e.state}"${e.since ? ` since ${time(e.since)}` : ""}`);
  if (controls?.length) {
    lines.push("Controllable entities:");
    for (const c of controls) lines.push(`- ${c.name} (${c.entityId}): ${c.state}`);
  }
  const h = data.extra?.health as HomeHealth | undefined;
  if (h) {
    const v = (n?: number) => (n === undefined ? "unknown" : n);
    lines.push(
      `Health: ${h.entities} entities, ${h.unavailable} unavailable, ${h.unknown} unknown, updates pending ${v(h.updatesPending)}, integrations failing ${v(h.integrationsFailing)}${h.failingDomains?.length ? ` (${h.failingDomains.join(", ")})` : ""}.`,
    );
  }
  return lines.join("\n").slice(0, 3800);
}
