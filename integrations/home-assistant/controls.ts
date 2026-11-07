import "server-only";
import { audit } from "@/server/audit";
import { sha256 } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { currentVia } from "@/server/work/actor";
import { resolveIntegration } from "@/integrations/store";
import {
  ATTRIBUTE_READBACK,
  EXPECTED_RESULT,
  HIGH_RISK_RATE,
  NO_STATE_READBACK,
  WRITE_RATE,
  actorMayExecute,
  allowedServicesFor,
  cleanServiceData,
  domainOf,
  inverseOf,
  roleMayRun,
  servicePolicy,
  serviceRisk,
  type HaRisk,
  type Inverse,
  type PriorState,
  type ServiceData,
} from "@/lib/ha-policy";
import { haConn, HomeAssistantClient, type HaState } from "./client";
import { parseAllowlist } from "./adapter";

export { EXPECTED_RESULT };

/** Domains shown in the House "Controls" section (doors, locks, alarm); others are device tiles. */
export const SENSITIVE_DOMAINS = ["lock", "cover", "alarm_control_panel", "valve"];

export const SERVICE_LABELS: Record<string, string> = {
  lock: "Lock",
  unlock: "Unlock",
  open: "Open",
  open_cover: "Open",
  close_cover: "Close",
  stop_cover: "Stop",
  turn_on: "Turn on",
  turn_off: "Turn off",
  toggle: "Toggle",
  alarm_disarm: "Disarm",
  alarm_arm_away: "Arm away",
  alarm_arm_home: "Arm home",
  alarm_arm_night: "Arm night",
};

export const serviceLabel = (entityId: string, service: string) =>
  SERVICE_LABELS[service] ?? servicePolicy(entityId, service)?.label ?? service.replace(/_/g, " ");

export function stateToken(s: Pick<HaState, "entity_id" | "state" | "last_changed">) {
  return sha256(`${s.entity_id}|${s.state}|${s.last_changed ?? ""}`).slice(0, 16);
}

export const controlRules = () => parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist);

export type ControlService = { service: string; label: string; wouldChange: boolean; risk: HaRisk };

export type ControlView = {
  entityId: string;
  name: string;
  domain: string;
  state: string;
  deviceClass?: string;
  lastChanged?: string;
  observedAt: string;
  stateToken: string;
  services: ControlService[];
};

export function controlServices(s: Pick<HaState, "state" | "attributes"> | undefined, entityId: string, services: string[]): ControlService[] {
  const dc = s ? String(s.attributes.device_class ?? "") : "";
  return services.map((service) => ({
    service,
    label: serviceLabel(entityId, service),
    wouldChange: !(EXPECTED_RESULT[service] ?? []).includes(s?.state ?? ""),
    risk: serviceRisk(entityId, service, dc),
  }));
}

/** Live state for the door/lock/alarm controls (exact rules of any domain + wildcard matches in SENSITIVE_DOMAINS). */
export async function listControls(role?: string): Promise<ControlView[]> {
  const rules = controlRules();
  if (!rules.length) return [];
  const states = await HomeAssistantClient.states(haConn());
  const observedAt = new Date().toISOString();
  const ids = new Set(rules.filter((r) => !r.entityId.endsWith(".*")).map((r) => r.entityId));
  for (const s of states) if (SENSITIVE_DOMAINS.includes(domainOf(s.entity_id)) && allowedServicesFor(rules, s.entity_id).length) ids.add(s.entity_id);
  return [...ids]
    .map((entityId) => {
      const s = states.find((x) => x.entity_id === entityId);
      return {
        entityId,
        name: String(s?.attributes.friendly_name ?? entityId),
        domain: domainOf(entityId),
        state: s?.state ?? "missing",
        deviceClass: s?.attributes.device_class ? String(s.attributes.device_class) : undefined,
        lastChanged: s?.last_changed,
        observedAt,
        stateToken: s ? stateToken(s) : "missing",
        services: controlServices(
          s,
          entityId,
          allowedServicesFor(rules, entityId).filter((svc) =>
            roleMayRun(role, entityId, svc, s?.attributes.device_class ? String(s.attributes.device_class) : null),
          ),
        ),
      };
    })
    .filter((c) => c.services.length);
}

export type ControlRequest = {
  entityId: string;
  service: string;
  stateToken: string;
  confirmed: boolean;
  /** service payload (brightness_pct, temperature, hvac_mode, percentage, volume_level) */
  data?: Record<string, unknown>;
  /** high-risk only: the person ticked the explicit "this device, this action" confirm */
  highRiskConfirmed?: boolean;
};

export type ControlUndo = Inverse & { label: string; risk: HaRisk };

export type ControlResult = {
  verified: boolean;
  state: string;
  message: string;
  /** fresh token for the read-back state (needed to Undo) */
  stateToken?: string;
  /** the call that reverses this one, when one exists */
  undo?: ControlUndo | null;
};

/* ---------- rate limits (per person, in-process) ---------- */

const hits = new Map<string, number[]>();
function reserve(key: string, limit: { max: number; windowMs: number }) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < limit.windowMs);
  const ok = list.length < limit.max;
  if (ok) list.push(now);
  hits.set(key, list);
  return ok;
}
/** tests only */
export function __resetControlRateLimits() {
  hits.clear();
}

export function priorOf(s: HaState): PriorState {
  const a = s.attributes;
  const n = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const b = n(a.brightness);
  return {
    state: s.state,
    brightnessPct: s.state === "on" && b !== undefined ? Math.max(1, Math.round((b / 255) * 100)) : undefined,
    temperature: n(a.temperature),
    hvacMode: domainOf(s.entity_id) === "climate" ? s.state : undefined,
    percentage: n(a.percentage),
    volume: n(a.volume_level),
  };
}

function readbackOk(service: string, entityId: string, data: ServiceData, before: HaState, now: HaState) {
  const key = `${domainOf(entityId)}.${service}`;
  if (service === "set_hvac_mode") return now.state === data.hvac_mode;
  const attr = ATTRIBUTE_READBACK[key];
  if (attr && Object.keys(data).length) return attr(now.attributes, data) && (EXPECTED_RESULT[service] ?? [now.state]).includes(now.state);
  if (service === "toggle") return now.state !== before.state;
  const expected = EXPECTED_RESULT[service];
  return expected ? expected.includes(now.state) : now.state !== before.state || now.last_updated !== before.last_updated;
}

/**
 * Execute an allowlisted control:
 *  1. must be allowed by the policy matrix AND the allowlist, and explicitly confirmed
 *  2. only a signed-in person executes: agents and scheduled jobs propose (Needs-you decision)
 *  3. high-risk (locks, alarm, opening a garage): an explicit second confirm + a rate limit
 *  4. live state must still match what the person saw (stateToken)
 *  5. success is reported only after Home Assistant reads back the new state
 */
export async function executeControl(
  req: ControlRequest,
  actor: string,
  correlationId: string,
  opts: { readbackTimeoutMs?: number; pollMs?: number; via?: string | null; role?: string } = {},
): Promise<ControlResult> {
  const base = { actor, action: `ha.${req.service}`, source: "home_assistant", sourceRecord: req.entityId, correlationId };
  const via = opts.via !== undefined ? opts.via : currentVia();
  const allowed = Boolean(servicePolicy(req.entityId, req.service)) && allowedServicesFor(controlRules(), req.entityId).includes(req.service);
  if (!allowed) {
    audit({ ...base, result: "rejected", detail: { reason: "not_allowlisted" } });
    throw new HttpError(403, "not_allowlisted", "That control is not in the allowlist.");
  }
  if (!actorMayExecute(via)) {
    audit({ ...base, result: "rejected", detail: { reason: "agent_must_propose", via } });
    throw new HttpError(403, "needs_owner", "Agents and scheduled jobs can't change devices; propose it and the owner confirms.");
  }
  if (!req.confirmed) throw new HttpError(400, "confirmation_required", "Confirm this action first.");
  let data: ServiceData;
  try {
    data = cleanServiceData(req.entityId, req.service, req.data);
  } catch (e) {
    throw new HttpError(400, "bad_data", (e as Error).message.replace(/^bad_data: /, ""));
  }
  const conn = haConn();
  const live = await HomeAssistantClient.state(conn, req.entityId);
  const dc = String(live.attributes.device_class ?? "");
  const risk = serviceRisk(req.entityId, req.service, dc);
  if (!roleMayRun(opts.role, req.entityId, req.service, dc)) {
    audit({ ...base, result: "rejected", detail: { reason: "household_safe_direction_only" } });
    throw new HttpError(403, "forbidden", "A shared household screen can only lock, close and arm. Sign in as yourself to do this.");
  }
  if (risk === "high" && !req.highRiskConfirmed) {
    audit({ ...base, result: "rejected", detail: { reason: "high_risk_confirmation_required" } });
    throw new HttpError(400, "high_risk_confirmation_required", "This is a high-risk action. Confirm the device and action explicitly.");
  }
  if (stateToken(live) !== req.stateToken) {
    audit({ ...base, result: "rejected", detail: { reason: "state_changed", state: live.state } });
    throw new HttpError(409, "state_changed", `State changed to “${live.state}” since you looked. Review and confirm again.`);
  }
  if (risk === "high" && !reserve(`h:${actor}`, HIGH_RISK_RATE)) {
    audit({ ...base, result: "rejected", detail: { reason: "rate_limited" } });
    throw new HttpError(429, "rate_limited", "Too many lock, alarm or garage actions in a short time. Wait a few minutes.");
  }
  if (!reserve(`w:${actor}`, WRITE_RATE)) throw new HttpError(429, "rate_limited", "Too many device changes in a minute. Wait a moment.");
  const domain = domainOf(req.entityId);
  audit({ ...base, result: "pending", detail: { from: live.state, risk, ...(Object.keys(data).length ? { data } : {}) } });
  try {
    await HomeAssistantClient.callService(conn, domain, req.service, { entity_id: req.entityId, ...data });
  } catch (err) {
    audit({ ...base, result: "error", detail: { error: (err as Error).message } });
    throw err;
  }
  const inv = inverseOf(req.entityId, req.service, priorOf(live));
  const undo: ControlUndo | null = inv ? { ...inv, label: serviceLabel(req.entityId, inv.service), risk: serviceRisk(req.entityId, inv.service, dc) } : null;
  if (NO_STATE_READBACK.has(`${domain}.${req.service}`)) {
    audit({ ...base, result: "ok", detail: { from: live.state } });
    return { verified: true, state: live.state, message: "Sent to Home Assistant", stateToken: stateToken(live), undo: null };
  }
  const deadline = Date.now() + (opts.readbackTimeoutMs ?? 10_000);
  let current = live;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
    current = await HomeAssistantClient.state(conn, req.entityId);
    if (readbackOk(req.service, req.entityId, data, live, current)) {
      audit({ ...base, result: "ok", detail: { from: live.state, to: current.state } });
      return { verified: true, state: current.state, message: `Confirmed: ${current.state}`, stateToken: stateToken(current), undo };
    }
  }
  audit({ ...base, result: "pending", detail: { from: live.state, to: current.state, reason: "readback_timeout" } });
  return {
    verified: false,
    state: current.state,
    message: `Sent to Home Assistant, but it still reports “${current.state}”. Check the device before trying again.`,
    stateToken: stateToken(current),
    undo: null,
  };
}
