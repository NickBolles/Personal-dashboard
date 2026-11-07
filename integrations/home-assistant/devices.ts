import "server-only";
import { audit } from "@/server/audit";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { joinUrl } from "@/server/http/fetch";
import { currentVia } from "@/server/work/actor";
import { resolveIntegration } from "@/integrations/store";
import { HA_DOMAIN_POLICY, actorMayExecute, allowedServicesFor, controlCap, domainOf, roleMayRun } from "@/lib/ha-policy";
import { haConn, HomeAssistantClient, type HaState } from "./client";
import { controlRules, controlServices, stateToken, type ControlService } from "./controls";

/**
 * Every Home Assistant device Jarvis shows on the House page, with the
 * controls this person may use. Allowed services come from the policy matrix
 * (lib/ha-policy.ts) ∩ the allowlist (Settings → Connections → Home
 * Assistant); doors, locks, covers and alarms need `home_assistant.control_doors`,
 * everything else `home_assistant.control_lights`. Every write is confirmed and
 * read back (controls.ts); nothing is queued.
 */
export type DeviceKind =
  | "lock"
  | "garage"
  | "door"
  | "window"
  | "cover"
  | "alarm"
  | "light"
  | "switch"
  | "fan"
  | "climate"
  | "media"
  | "scene"
  | "script"
  | "toggle"
  | "vacuum"
  | "camera";

export type DeviceView = {
  entityId: string;
  name: string;
  kind: DeviceKind;
  state: string;
  lastChanged?: string;
  /** lights: 0–100 when on and dimmable */
  brightness?: number;
  /** climate */
  temperature?: number;
  currentTemperature?: number;
  hvacModes?: string[];
  minTemp?: number;
  maxTemp?: number;
  /** fan speed 0–100 */
  percentage?: number;
  /** media volume 0–100 */
  volume?: number;
  stateToken: string;
  services: ControlService[];
  /** H1: Home Assistant area (room); absent = unassigned or unreadable */
  area?: string;
};

const OPENING_CLASSES = ["door", "garage_door", "window", "opening"];

const DOMAIN_KIND: Record<string, DeviceKind> = {
  lock: "lock",
  light: "light",
  camera: "camera",
  alarm_control_panel: "alarm",
  switch: "switch",
  fan: "fan",
  climate: "climate",
  media_player: "media",
  scene: "scene",
  script: "script",
  input_boolean: "toggle",
  vacuum: "vacuum",
};

/** Kinds shown with doors/locks (status + Controls section), not as device tiles. */
export const SECURITY_KINDS: DeviceKind[] = ["lock", "garage", "door", "window", "cover", "alarm"];

export function deviceKind(s: HaState): DeviceKind | null {
  const domain = domainOf(s.entity_id);
  const dc = String(s.attributes.device_class ?? "");
  if (domain === "cover") return dc === "garage" ? "garage" : dc === "door" ? "door" : dc === "window" ? "window" : "cover";
  if (domain === "binary_sensor" && OPENING_CLASSES.includes(dc)) return dc === "window" ? "window" : dc === "garage_door" ? "garage" : "door";
  return DOMAIN_KIND[domain] ?? null;
}

export function lightControlMode(): "all" | "allowlist" | "none" {
  const v = resolveIntegration("home_assistant").config.lightControl;
  return v === "allowlist" || v === "none" ? v : "all";
}

function lightServices(entityId: string): string[] {
  const mode = lightControlMode();
  if (mode === "none") return [];
  if (mode === "all") return Object.keys(HA_DOMAIN_POLICY.light!);
  return allowedServicesFor(controlRules(), entityId);
}

function lightAllowed(entityId: string) {
  return lightServices(entityId).length > 0;
}

const num = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function toDevice(s: HaState, opts: { doorControls: boolean; lightControls: boolean; role?: string }, rules = controlRules()): DeviceView | null {
  const kind = deviceKind(s);
  if (!kind) return null;
  const cap = controlCap(s.entity_id);
  const may = cap === "home_assistant.control_doors" ? opts.doorControls : opts.lightControls;
  let names: string[] = [];
  if (may && kind !== "camera" && domainOf(s.entity_id) !== "binary_sensor") {
    names = (kind === "light" ? lightServices(s.entity_id) : allowedServicesFor(rules, s.entity_id)).filter((svc) =>
      roleMayRun(opts.role, s.entity_id, svc, String(s.attributes.device_class ?? "")),
    );
  }
  const a = s.attributes;
  const b = num(a.brightness);
  const vol = num(a.volume_level);
  return {
    entityId: s.entity_id,
    name: String(a.friendly_name ?? s.entity_id),
    kind,
    state: s.state,
    lastChanged: s.last_changed,
    brightness: kind === "light" && s.state === "on" && b !== undefined ? Math.round((b / 255) * 100) : undefined,
    ...(kind === "climate"
      ? {
          temperature: num(a.temperature),
          currentTemperature: num(a.current_temperature),
          hvacModes: Array.isArray(a.hvac_modes) ? (a.hvac_modes as unknown[]).map(String) : undefined,
          minTemp: num(a.min_temp),
          maxTemp: num(a.max_temp),
        }
      : {}),
    ...(kind === "fan" ? { percentage: num(a.percentage) } : {}),
    ...(kind === "media" && vol !== undefined ? { volume: Math.round(vol * 100) } : {}),
    stateToken: stateToken(s),
    services: controlServices(s, s.entity_id, names),
  };
}

export async function listDevices(opts: { doors: boolean; lights: boolean; cameras: boolean; doorControls: boolean; lightControls: boolean; role?: string }) {
  const states = await HomeAssistantClient.states(haConn());
  const rules = controlRules();
  const all = states.map((s) => toDevice(s, opts, rules)).filter((d): d is DeviceView => Boolean(d));
  // H1: rooms are best-effort — a failed or forbidden area read leaves every device "Unassigned".
  const areas = await HomeAssistantClient.areaNames(
    haConn(),
    all.map((d) => d.entityId),
  ).catch(() => undefined);
  for (const d of all) {
    const a = areas?.get(d.entityId);
    if (a) d.area = a;
  }
  const byName = (a: DeviceView, b: DeviceView) => a.name.localeCompare(b.name);
  return {
    fetchedAt: new Date().toISOString(),
    lightControl: lightControlMode(),
    /** false when Home Assistant wouldn't tell us the rooms (non-admin token) */
    roomsKnown: areas !== undefined,
    doors: opts.doors ? all.filter((d) => SECURITY_KINDS.includes(d.kind)).sort(byName) : [],
    lights: opts.lights ? all.filter((d) => d.kind === "light").sort(byName) : [],
    /** switches, fans, climate, media, scenes, scripts, toggles, vacuums */
    others: opts.lights ? all.filter((d) => !SECURITY_KINDS.includes(d.kind) && d.kind !== "light" && d.kind !== "camera").sort(byName) : [],
    cameras: opts.cameras ? all.filter((d) => d.kind === "camera").sort(byName) : [],
  };
}

/** Turn a light on or off; success only once Home Assistant reads back the new state. (Android + older clients.) */
export async function switchLight(
  entityId: string,
  on: boolean,
  actor: string,
  correlationId: string,
  opts: { readbackTimeoutMs?: number; pollMs?: number } = {},
) {
  if (!/^light\.[a-z0-9_]+$/.test(entityId)) throw new HttpError(400, "not_a_light", "That isn't a light.");
  const service = on ? "turn_on" : "turn_off";
  const base = { actor, action: `ha.${service}`, source: "home_assistant", sourceRecord: entityId, correlationId };
  if (!lightAllowed(entityId)) {
    audit({ ...base, result: "rejected", detail: { reason: "not_allowed" } });
    throw new HttpError(403, "not_allowlisted", "Jarvis isn't allowed to switch that light (Settings → Connections → Home Assistant).");
  }
  if (!actorMayExecute(currentVia())) {
    audit({ ...base, result: "rejected", detail: { reason: "agent_must_propose" } });
    throw new HttpError(403, "needs_owner", "Agents and scheduled jobs can't change devices; propose it and the owner confirms.");
  }
  const conn = haConn();
  const live = await HomeAssistantClient.state(conn, entityId);
  const want = on ? "on" : "off";
  if (live.state === want) return { verified: true as const, state: live.state, message: `Already ${want}` };
  if (live.state === "unavailable") throw new HttpError(409, "unavailable", "That light isn't reporting right now.");
  audit({ ...base, result: "pending", detail: { from: live.state } });
  await HomeAssistantClient.callService(conn, "light", service, { entity_id: entityId });
  const deadline = Date.now() + (opts.readbackTimeoutMs ?? 8_000);
  let current = live;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
    current = await HomeAssistantClient.state(conn, entityId);
    if (current.state === want) {
      audit({ ...base, result: "ok", detail: { from: live.state, to: current.state } });
      return { verified: true as const, state: current.state, message: `Confirmed: ${current.state}` };
    }
  }
  audit({ ...base, result: "pending", detail: { from: live.state, to: current.state, reason: "readback_timeout" } });
  return { verified: false as const, state: current.state, message: `Sent, but Home Assistant still reports “${current.state}”.` };
}

/** A fresh camera still, proxied so the Home Assistant token never reaches the browser. Never cached. */
export async function cameraSnapshot(entityId: string, signal?: AbortSignal): Promise<Response> {
  if (!/^camera\.[a-z0-9_]+$/.test(entityId)) throw new HttpError(400, "not_a_camera", "That isn't a camera.");
  const c = haConn();
  let res: Response;
  try {
    res = await fetch(joinUrl(c.baseUrl, `/api/camera_proxy/${encodeURIComponent(entityId)}`), {
      headers: { accept: "image/*", ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    throw new UpstreamError("Home Assistant", "unreachable", "Couldn't reach Home Assistant for the camera image");
  }
  if (res.status === 401 || res.status === 403) throw new UpstreamError("Home Assistant", "unauthorized", "Home Assistant rejected the token");
  if (!res.ok || !res.body) throw new UpstreamError("Home Assistant", "bad_response", `Camera image unavailable (${res.status})`);
  const type = res.headers.get("content-type") ?? "image/jpeg";
  if (!type.startsWith("image/")) throw new UpstreamError("Home Assistant", "bad_response", "Camera returned something that isn't an image");
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
}
