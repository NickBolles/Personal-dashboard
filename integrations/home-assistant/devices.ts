import "server-only";
import { audit } from "@/server/audit";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { joinUrl } from "@/server/http/fetch";
import { resolveIntegration } from "@/integrations/store";
import { haConn, HomeAssistantClient, type HaState } from "./client";
import { parseAllowlist } from "./adapter";
import { EXPECTED_RESULT, SERVICE_LABELS, stateToken } from "./controls";

/**
 * Every door, lock, light and camera Home Assistant knows about, for viewing.
 * Doors and locks are controlled only through the confirmed allowlist
 * (controls.ts). Lights can be switched directly (setting: all lights, only
 * allowlisted ones, or none), always with readback, never queued.
 */
export type DeviceKind = "lock" | "garage" | "door" | "window" | "cover" | "light" | "camera";

export type DeviceView = {
  entityId: string;
  name: string;
  kind: DeviceKind;
  state: string;
  lastChanged?: string;
  /** lights: 0–100 when on and dimmable */
  brightness?: number;
  stateToken: string;
  /** allowlisted door/lock services, or light on/off */
  services: { service: string; label: string; wouldChange: boolean }[];
};

const OPENING_CLASSES = ["door", "garage_door", "window", "opening"];

export function deviceKind(s: HaState): DeviceKind | null {
  const [domain] = s.entity_id.split(".");
  const dc = String(s.attributes.device_class ?? "");
  if (domain === "lock") return "lock";
  if (domain === "light") return "light";
  if (domain === "camera") return "camera";
  if (domain === "cover") return dc === "garage" ? "garage" : dc === "door" ? "door" : dc === "window" ? "window" : "cover";
  if (domain === "binary_sensor" && OPENING_CLASSES.includes(dc)) return dc === "window" ? "window" : dc === "garage_door" ? "garage" : "door";
  return null;
}

export function lightControlMode(): "all" | "allowlist" | "none" {
  const v = resolveIntegration("home_assistant").config.lightControl;
  return v === "allowlist" || v === "none" ? v : "all";
}

function lightAllowed(entityId: string) {
  const mode = lightControlMode();
  if (mode === "none") return false;
  if (mode === "all") return true;
  return parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist).some((r) => r.entityId === entityId);
}

export function toDevice(s: HaState, opts: { doorControls: boolean; lightControls: boolean }): DeviceView | null {
  const kind = deviceKind(s);
  if (!kind) return null;
  const rules = parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist);
  let services: DeviceView["services"] = [];
  if (kind === "light" && opts.lightControls && lightAllowed(s.entity_id)) {
    services = ["turn_on", "turn_off"].map((service) => ({
      service,
      label: SERVICE_LABELS[service]!,
      wouldChange: !(EXPECTED_RESULT[service] ?? []).includes(s.state),
    }));
  } else if (kind !== "light" && kind !== "camera" && opts.doorControls) {
    services = (rules.find((r) => r.entityId === s.entity_id)?.services ?? []).map((service) => ({
      service,
      label: SERVICE_LABELS[service] ?? service.replace(/_/g, " "),
      wouldChange: !(EXPECTED_RESULT[service] ?? []).includes(s.state),
    }));
  }
  const b = Number(s.attributes.brightness);
  return {
    entityId: s.entity_id,
    name: String(s.attributes.friendly_name ?? s.entity_id),
    kind,
    state: s.state,
    lastChanged: s.last_changed,
    brightness: kind === "light" && s.state === "on" && Number.isFinite(b) ? Math.round((b / 255) * 100) : undefined,
    stateToken: stateToken(s),
    services,
  };
}

export async function listDevices(opts: { doors: boolean; lights: boolean; cameras: boolean; doorControls: boolean; lightControls: boolean }) {
  const states = await HomeAssistantClient.states(haConn());
  const all = states.map((s) => toDevice(s, opts)).filter((d): d is DeviceView => Boolean(d));
  const byName = (a: DeviceView, b: DeviceView) => a.name.localeCompare(b.name);
  return {
    fetchedAt: new Date().toISOString(),
    lightControl: lightControlMode(),
    doors: opts.doors ? all.filter((d) => d.kind !== "light" && d.kind !== "camera").sort(byName) : [],
    lights: opts.lights ? all.filter((d) => d.kind === "light").sort(byName) : [],
    cameras: opts.cameras ? all.filter((d) => d.kind === "camera").sort(byName) : [],
  };
}

/** Turn a light on or off; success only once Home Assistant reads back the new state. */
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
