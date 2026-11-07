"use client";

import { useAccess } from "@/components/access";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { CalendarEvent, HomeHealth, SourceStatus } from "@/lib/contracts";
import type { DeviceView } from "@/integrations/home-assistant/devices";
import { CameraIcon, ChevronIcon, LightIcon } from "@/components/icons";
import { useSource } from "@/components/useSource";
import { Banner, ChipSelect, EmptyState, SectionHeader, ErrorNote, PageHeader, cx, useNow, useOnline } from "@/components/ui";
import { Badge, Button, ButtonLink, Card, Spinner } from "@/components/ui/legacy";
import { SourceState } from "@/components/SourceState";
import { useHaControl, type HaAction } from "@/components/home/HaControls";
import type { HaRisk } from "@/lib/ha-policy";
import { groupByRoom, roomSlug } from "@/lib/house-rooms";

type Control = {
  entityId: string;
  name: string;
  domain: string;
  state: string;
  lastChanged?: string;
  observedAt: string;
  stateToken: string;
  services: { service: string; label: string; wouldChange: boolean; risk: HaRisk }[];
};

export function HomeControlView({ focusEntity, propose }: { focusEntity?: string; propose?: Proposal }) {
  const online = useOnline();
  const { can } = useAccess();
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

  const ctl = useHaControl();
  const pendingId = ctl.pending?.entityId;

  const now = useNow(5_000);
  const exceptions = home.data?.data?.homeExceptions ?? [];
  const controlsFresh = controls.data && now - new Date(controls.data.fetchedAt).getTime() < 60_000;

  return (
    <div className="@container mx-auto max-w-3xl px-4 pt-4 pb-6 sm:px-6 dense:pt-5 dense:max-w-6xl">
      <PageHeader
        title="House"
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

      {/* Desktop: two balanced columns (owner default); each section stays whole. */}
      <div className="@min-[880px]:columns-2 @min-[880px]:gap-6 @min-[880px]:[&>section]:mt-0 @min-[880px]:[&>section]:mb-6 [&>section]:break-inside-avoid">
        {can("home_assistant.calendar") && home.data?.data?.events?.length ? <CalendarSection events={home.data.data.events} /> : null}

        {home.data?.data && can("home_assistant.view") ? (
          <section aria-labelledby="ex-h" className="mt-4">
            <SectionHeader id="ex-h" label="Exceptions" />
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
                      {e.reason} · state “{e.state}”
                      {e.since ? ` since ${new Date(e.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing unusual in your watched entities." />
            )}
          </section>
        ) : null}

        {can("home_assistant.view") || can("home_assistant.cameras") ? <Devices focusEntity={focusEntity} online={online} propose={propose} /> : null}

        {can("home_assistant.view") && home.data?.status && home.data.status.state !== "unconfigured" && home.data.status.state !== "disabled" ? (
          <HealthPanel status={home.data.status} health={home.data.data?.extra?.health as HomeHealth | undefined} />
        ) : null}

        {can("home_assistant.control_doors") ? (
          <section aria-labelledby="ctl-h" className="@container mt-6">
            <SectionHeader id="ctl-h" label="Controls" />
            {!online ? (
              <Banner tone="wn">Controls are disabled while offline. Jarvis never queues physical actions; they’ll re-enable after a fresh state check.</Banner>
            ) : null}
            {controls.error ? <ErrorNote error={controls.error} retry={() => controls.refetch()} /> : null}
            {controls.isLoading ? <Spinner label="Reading live state…" /> : null}
            {controls.data && !controls.data.controls.length ? (
              <EmptyState title="No controls allowlisted. Add some in Settings → Connections → Home Assistant." />
            ) : null}
            {ctl.toast}
            {/* H1: compact two-line tiles, three across on desktops. */}
            <ul className="grid grid-cols-1 gap-2 @min-[400px]:grid-cols-2 @min-[760px]:grid-cols-3">
              {(controls.data?.controls ?? []).map((c) => (
                <li key={c.entityId}>
                  <Card className={cx(focusEntity === c.entityId && "border-accent")}>
                    <p className="leading-snug font-medium">{c.name}</p>
                    <p className="text-xs text-muted">
                      Now: <strong className="text-text">{c.state}</strong> · checked {new Date(c.observedAt).toLocaleTimeString()}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {c.services.map((s) => (
                        <Button
                          key={s.service}
                          size="sm"
                          variant="secondary"
                          disabled={!online || !controlsFresh || c.state === "missing" || pendingId === c.entityId}
                          busy={pendingId === c.entityId && ctl.pending?.service === s.service}
                          onClick={() =>
                            ctl.request({
                              entityId: c.entityId,
                              name: c.name,
                              state: c.state,
                              stateToken: c.stateToken,
                              service: s.service,
                              label: s.label,
                              // Door controls always get the confirm card, even when the policy calls them low-risk.
                              risk: s.risk === "low" ? "standard" : s.risk,
                              observedAt: c.observedAt,
                            })
                          }
                          aria-label={`${s.label} ${c.name}`}
                        >
                          {s.label}
                          {s.risk === "high" ? <span className="sr-only"> (high-risk)</span> : null}
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
      </div>

      {ctl.dialog}
    </div>
  );
}

function CalendarSection({ events }: { events: CalendarEvent[] }) {
  return (
    <section aria-labelledby="cal-h" className="mt-4">
      <SectionHeader id="cal-h" label="Household calendar" />
      <ul className="card divide-y divide-line">
        {events.slice(0, 10).map((e) => (
          <li key={e.id} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm">
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

type Devices = {
  fetchedAt: string;
  lightControl: string;
  roomsKnown?: boolean;
  doors: DeviceView[];
  lights: DeviceView[];
  others?: DeviceView[];
  cameras: DeviceView[];
};

type HouseView = "rooms" | "all";

/** ?propose=<service>&data=<json> from an agent proposal (validated again by the server on confirm). */
export type Proposal = { service: string; data?: HaAction["data"] };
const VIEW_KEY = "jarvis:house-view";
const COLLAPSED_KEY = "jarvis:house-collapsed";
const readLocal = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeLocal = (key: string, v: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: the choice just isn't remembered */
  }
};

const KIND_LABEL: Record<DeviceView["kind"], string> = {
  lock: "Lock",
  garage: "Garage",
  door: "Door",
  window: "Window",
  cover: "Cover",
  alarm: "Alarm",
  light: "Light",
  switch: "Switch",
  fan: "Fan",
  climate: "Climate",
  media: "Media",
  scene: "Scene",
  script: "Script",
  toggle: "Toggle",
  vacuum: "Vacuum",
  camera: "Camera",
};

type Ctl = ReturnType<typeof useHaControl>;

/** A device tap → HaAction (service must be one the server offered for this device). */
function actionFor(x: DeviceView, service: string, data?: HaAction["data"]): HaAction | null {
  const s = x.services.find((v) => v.service === service);
  if (!s) return null;
  return { entityId: x.entityId, name: x.name, state: x.state, stateToken: x.stateToken, service, label: s.label, risk: s.risk, data };
}

function Devices({ focusEntity, online, propose }: { focusEntity?: string; online: boolean; propose?: Proposal }) {
  const ctl = useHaControl();
  const q = useQuery({
    queryKey: ["ha", "devices"],
    queryFn: () => api.get<Devices>("/api/home-assistant/devices"),
    enabled: online,
    refetchInterval: 15_000,
    gcTime: 0,
  });
  // H1: By room (default when Home Assistant shares rooms) or All (by kind); remembered on this device.
  const [view, setView] = useState<HouseView | null>(() => readLocal<HouseView | null>(VIEW_KEY, null));
  const [collapsed, setCollapsed] = useState<string[]>(() => readLocal<string[]>(COLLAPSED_KEY, []));
  // An agent's proposal (Needs-you → "Confirm it on House") opens the confirm card once; the owner decides.
  const proposed = useRef(false);
  const request = ctl.request;
  useEffect(() => {
    if (proposed.current || !propose || !focusEntity || !q.data) return;
    const x = [...q.data.doors, ...q.data.lights, ...(q.data.others ?? [])].find((d) => d.entityId === focusEntity);
    if (!x) return;
    proposed.current = true;
    const a = actionFor(x, propose.service, propose.data);
    if (a) request({ ...a, risk: a.risk === "low" ? "standard" : a.risk });
  }, [q.data, propose, focusEntity, request]);
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return q.isLoading ? <Spinner label="Reading devices…" /> : null;
  const d = q.data;
  const others = d.others ?? [];
  const all = [...d.doors, ...d.lights, ...others, ...d.cameras];
  const hasRooms = all.some((x) => x.area);
  const mode: HouseView = view ?? (hasRooms ? "rooms" : "all");
  const choose = (v: HouseView) => {
    setView(v);
    writeLocal(VIEW_KEY, v);
  };
  const toggleRoom = (room: string) =>
    setCollapsed((c) => {
      const next = c.includes(room) ? c.filter((r) => r !== room) : [...c, room];
      writeLocal(COLLAPSED_KEY, next);
      return next;
    });
  const tile = (x: DeviceView) =>
    x.kind === "camera" ? (
      <CameraCard key={x.entityId} camera={x} online={online} />
    ) : x.kind === "light" ? (
      <LightTile key={x.entityId} x={x} focus={focusEntity === x.entityId} online={online} ctl={ctl} />
    ) : others.includes(x) ? (
      <DeviceTile key={x.entityId} x={x} focus={focusEntity === x.entityId} online={online} ctl={ctl} />
    ) : (
      <DoorTile key={x.entityId} x={x} focus={focusEntity === x.entityId} />
    );
  const toggle = all.length ? (
    <div className={cx("flex flex-wrap items-center justify-between gap-2", mode === "rooms" ? "" : "mt-6 dense:mt-0 dense:mb-2")}>
      <div role="group" aria-label="Group devices" className="seg">
        <button type="button" className="seg-item" aria-pressed={mode === "rooms"} onClick={() => choose("rooms")}>
          By room
        </button>
        <button type="button" className="seg-item" aria-pressed={mode === "all"} onClick={() => choose("all")}>
          All
        </button>
      </div>
      {mode === "rooms" && d.roomsKnown === false ? (
        <p className="text-xs text-muted">Home Assistant didn&apos;t share rooms with this token (needs an admin token), so everything is Unassigned.</p>
      ) : null}
    </div>
  ) : null;
  const offlineNote =
    !online && (d.lights.length || others.length) ? <p className="mt-2 mb-2 text-sm text-warn">Device controls are off while offline.</p> : null;
  const grid = "grid grid-cols-1 gap-2 @min-[400px]:grid-cols-2 @min-[760px]:grid-cols-3";
  return mode === "rooms" ? (
    // All rooms live in ONE section, so on desktop the page's two columns keep Health/Controls where they
    // were instead of rooms spilling into the right column.
    <section aria-label="Devices by room" className="mt-6 flex flex-col gap-4" data-rooms>
      {toggle}
      {offlineNote}
      {ctl.toast}
      {groupByRoom(all).map(({ room, devices }) => {
        const id = `room-${roomSlug(room)}`;
        // A deep-linked device (search → ?entity=) always shows, even in a collapsed room.
        const open = !collapsed.includes(room) || devices.some((x) => x.entityId === focusEntity);
        return (
          <section key={room} aria-labelledby={`${id}-h`} className="@container" data-room={room}>
            <h2 id={`${id}-h`} className="mb-1.5">
              <button
                type="button"
                className="tap -mx-1 inline-flex items-center gap-1.5 rounded-lg px-1 text-[13px] font-semibold text-muted hover:text-text"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => toggleRoom(room)}
              >
                <ChevronIcon className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
                {room}
                <span className="tabular-nums font-normal">{devices.length}</span>
              </button>
            </h2>
            {open ? (
              <ul id={id} className={grid}>
                {devices.map(tile)}
              </ul>
            ) : null}
          </section>
        );
      })}
      {ctl.dialog}
    </section>
  ) : (
    <>
      {toggle}
      {offlineNote}
      {ctl.toast}
      {d.doors.length ? (
        <section aria-labelledby="doors-h" className="@container mt-6">
          <SectionHeader id="doors-h" label="Doors, locks and garage" />
          <ul className={grid}>{d.doors.map(tile)}</ul>
        </section>
      ) : null}
      {d.lights.length ? (
        <section aria-labelledby="lights-h" className="@container mt-6">
          <SectionHeader id="lights-h" label="Lights" />
          <ul className={grid}>{d.lights.map(tile)}</ul>
        </section>
      ) : null}
      {others.length ? (
        <section aria-labelledby="other-h" className="@container mt-6">
          <SectionHeader id="other-h" label="Switches, climate and media" />
          <ul className={grid}>{others.map(tile)}</ul>
        </section>
      ) : null}
      {d.cameras.length ? (
        <section aria-labelledby="cams-h" className="@container mt-6">
          <SectionHeader id="cams-h" label="Cameras" />
          <ul className="grid grid-cols-1 gap-3 @min-[400px]:grid-cols-2 @min-[760px]:grid-cols-3">
            {d.cameras.map((c) => (
              <CameraCard key={c.entityId} camera={c} online={online} />
            ))}
          </ul>
        </section>
      ) : null}
      {ctl.dialog}
    </>
  );
}

function DoorTile({ x, focus }: { x: DeviceView; focus: boolean }) {
  return (
    <li className={cx("card flex flex-wrap items-center justify-between gap-2 px-3 py-2", focus && "border-accent")} data-entity={x.entityId}>
      <span className="min-w-0">
        <span className="block font-medium">{x.name}</span>
        <span className="text-xs text-muted">{KIND_LABEL[x.kind]}</span>
      </span>
      <Badge tone={["open", "unlocked", "on", "opening", "triggered"].includes(x.state) ? "warn" : x.state === "unavailable" ? "neutral" : "ok"}>
        {x.kind === "door" || x.kind === "window" ? (x.state === "on" ? "open" : x.state === "off" ? "closed" : x.state) : x.state}
      </Badge>
    </li>
  );
}

/** Compact on/off switch (role=switch) for a device that has turn_on/turn_off (or toggle). */
function PowerSwitch({ x, online, ctl }: { x: DeviceView; online: boolean; ctl: Ctl }) {
  const on = x.state === "on" || x.state === "playing";
  const svc = x.services.some((s) => s.service === (on ? "turn_off" : "turn_on")) ? (on ? "turn_off" : "turn_on") : "toggle";
  const act = actionFor(x, svc);
  if (!act) return null;
  const busy = ctl.pending?.entityId === x.entityId;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${x.name}: ${on ? "on, turn off" : "off, turn on"}`}
      className={cx("k-toggle min-h-11 sm:min-h-10 dense:min-h-6", on && "k-toggle-on")}
      disabled={!online || x.state === "unavailable" || busy}
      onClick={() => ctl.request(act)}
    >
      <span className="k-toggle-t" aria-hidden>
        <span className="k-toggle-k" />
      </span>
    </button>
  );
}

/** Slider that sends one change on release (pointer up / key up), never per pixel. */
function LevelSlider({
  x,
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = "%",
  disabled,
  onCommit,
}: {
  x: DeviceView;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number>();
  const v = draft ?? value;
  const commit = () => {
    if (draft !== undefined && draft !== value) onCommit(draft);
    setDraft(undefined);
  };
  return (
    <label className="flex min-w-0 flex-1 basis-full items-center gap-2 text-xs text-muted">
      <span className="sr-only">
        {label} {x.name}
      </span>
      <input
        type="range"
        className="ha-range min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={v}
        disabled={disabled}
        aria-valuetext={`${v}${unit}`}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-10 shrink-0 text-right tabular-nums" data-dynamic>
        {v}
        {unit}
      </span>
    </label>
  );
}

function LightTile({ x, focus, online, ctl }: { x: DeviceView; focus: boolean; online: boolean; ctl: Ctl }) {
  const on = x.state === "on";
  const dimmable = on && x.brightness !== undefined && x.services.some((s) => s.service === "turn_on");
  const busy = ctl.pending?.entityId === x.entityId;
  return (
    <li className={cx("card flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-2", focus && "border-accent")} data-entity={x.entityId}>
      <span className="flex min-w-0 items-center gap-2">
        <LightIcon className={cx("h-5 w-5 shrink-0", on ? "text-warn" : "text-muted")} />
        <span className="min-w-0">
          <span className="block font-medium">{x.name}</span>
          <span className="text-xs text-muted">
            {x.state}
            {x.brightness !== undefined ? ` · ${x.brightness}%` : ""}
          </span>
        </span>
      </span>
      {x.services.length ? <PowerSwitch x={x} online={online} ctl={ctl} /> : null}
      {dimmable ? (
        <LevelSlider
          x={x}
          label="Brightness"
          value={x.brightness!}
          min={1}
          disabled={!online || busy}
          onCommit={(v) => {
            const a = actionFor(x, "turn_on", { brightness_pct: v });
            if (a) ctl.request({ ...a, label: "Set brightness" });
          }}
        />
      ) : null}
    </li>
  );
}

/** Switches, fans, climate, media, scenes, scripts, toggles and vacuums: compact inline controls. */
function DeviceTile({ x, focus, online, ctl }: { x: DeviceView; focus: boolean; online: boolean; ctl: Ctl }) {
  const busy = ctl.pending?.entityId === x.entityId;
  const off = !online || x.state === "unavailable" || busy;
  const has = (s: string) => x.services.some((v) => v.service === s);
  const run = (service: string, data?: HaAction["data"], label?: string) => {
    const a = actionFor(x, service, data);
    if (a) ctl.request(label ? { ...a, label } : a);
  };
  const sub =
    x.kind === "climate"
      ? `${x.state}${x.currentTemperature !== undefined ? ` · now ${x.currentTemperature}°` : ""}`
      : x.kind === "fan" && x.percentage !== undefined
        ? `${x.state} · ${x.percentage}%`
        : x.kind === "scene" || x.kind === "script"
          ? KIND_LABEL[x.kind]
          : x.state;
  const power = (x.kind === "switch" || x.kind === "toggle" || x.kind === "fan" || x.kind === "media") && (has("turn_on") || has("toggle"));
  return (
    <li className={cx("card flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-2", focus && "border-accent")} data-entity={x.entityId}>
      <span className="min-w-0">
        <span className="block font-medium">{x.name}</span>
        <span className="text-xs text-muted">{sub}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {x.kind === "media" && has("media_play") && x.state !== "playing" ? (
          <Button size="sm" variant="secondary" disabled={off} onClick={() => run("media_play")} aria-label={`Play ${x.name}`}>
            Play
          </Button>
        ) : null}
        {x.kind === "media" && has("media_pause") && x.state === "playing" ? (
          <Button size="sm" variant="secondary" disabled={off} onClick={() => run("media_pause")} aria-label={`Pause ${x.name}`}>
            Pause
          </Button>
        ) : null}
        {(x.kind === "scene" || x.kind === "script") && has("turn_on") ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={off}
            busy={busy}
            onClick={() => run("turn_on")}
            aria-label={`${x.kind === "scene" ? "Activate" : "Run"} ${x.name}`}
          >
            {x.kind === "scene" ? "Activate" : "Run"}
          </Button>
        ) : null}
        {x.kind === "vacuum" && has("start") && x.state !== "cleaning" ? (
          <Button size="sm" variant="secondary" disabled={off} onClick={() => run("start")} aria-label={`Start ${x.name}`}>
            Start
          </Button>
        ) : null}
        {x.kind === "vacuum" && has("return_to_base") && x.state !== "docked" ? (
          <Button size="sm" variant="secondary" disabled={off} onClick={() => run("return_to_base")} aria-label={`Send ${x.name} home`}>
            Send home
          </Button>
        ) : null}
        {x.kind === "climate" && has("set_temperature") && x.temperature !== undefined ? (
          <span className="inline-flex items-center gap-1" role="group" aria-label={`${x.name} target temperature`}>
            <Button
              size="sm"
              variant="secondary"
              disabled={off || (x.minTemp !== undefined && x.temperature - 1 < x.minTemp)}
              onClick={() => run("set_temperature", { temperature: x.temperature! - 1 }, `Set to ${x.temperature! - 1}°`)}
              aria-label={`Lower ${x.name} to ${x.temperature - 1}°`}
            >
              −
            </Button>
            <span className="w-10 text-center tabular-nums font-medium">{x.temperature}°</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={off || (x.maxTemp !== undefined && x.temperature + 1 > x.maxTemp)}
              onClick={() => run("set_temperature", { temperature: x.temperature! + 1 }, `Set to ${x.temperature! + 1}°`)}
              aria-label={`Raise ${x.name} to ${x.temperature + 1}°`}
            >
              +
            </Button>
          </span>
        ) : null}
        {x.kind === "climate" && has("set_hvac_mode") && x.hvacModes?.length ? (
          <ChipSelect
            aria-label={`${x.name} mode`}
            value={x.state}
            disabled={off}
            onChange={(e) => run("set_hvac_mode", { hvac_mode: e.target.value }, `Set mode to ${e.target.value}`)}
          >
            {x.hvacModes.map((m) => (
              <option key={m} value={m}>
                {m.replace(/_/g, " ")}
              </option>
            ))}
          </ChipSelect>
        ) : null}
        {power ? <PowerSwitch x={x} online={online} ctl={ctl} /> : null}
      </span>
      {x.kind === "fan" && has("set_percentage") && x.state === "on" && x.percentage !== undefined ? (
        <LevelSlider x={x} label="Speed" value={x.percentage} disabled={off} onCommit={(v) => run("set_percentage", { percentage: v }, "Set speed")} />
      ) : null}
      {x.kind === "media" && has("volume_set") && x.volume !== undefined ? (
        <LevelSlider x={x} label="Volume" value={x.volume} disabled={off} onCommit={(v) => run("volume_set", { volume_level: v / 100 }, "Set volume")} />
      ) : null}
    </li>
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
      <SectionHeader id="health-h" label="Home Assistant health" />
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
