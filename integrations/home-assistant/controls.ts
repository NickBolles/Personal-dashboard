import "server-only";
import { audit } from "@/server/audit";
import { sha256 } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { resolveIntegration } from "@/integrations/store";
import { haConn, HomeAssistantClient, type HaState } from "./client";
import { parseAllowlist } from "./adapter";

/** Resulting states that count as confirmation for each service. */
export const EXPECTED_RESULT: Record<string, string[]> = {
  lock: ["locked"],
  unlock: ["unlocked", "open"],
  open: ["open", "unlocked"],
  open_cover: ["open", "opening"],
  close_cover: ["closed", "closing"],
  turn_on: ["on"],
  turn_off: ["off"],
  alarm_disarm: ["disarmed"],
  alarm_arm_away: ["armed_away", "arming"],
  alarm_arm_home: ["armed_home", "arming"],
  alarm_arm_night: ["armed_night", "arming"],
};

/** Actions affecting physical security always require explicit confirmation. */
export const SENSITIVE_DOMAINS = ["lock", "cover", "alarm_control_panel", "garage", "valve", "switch"];

export const SERVICE_LABELS: Record<string, string> = {
  lock: "Lock",
  unlock: "Unlock",
  open: "Open",
  open_cover: "Open",
  close_cover: "Close",
  turn_on: "Turn on",
  turn_off: "Turn off",
  alarm_disarm: "Disarm",
  alarm_arm_away: "Arm away",
  alarm_arm_home: "Arm home",
  alarm_arm_night: "Arm night",
};

export function stateToken(s: Pick<HaState, "entity_id" | "state" | "last_changed">) {
  return sha256(`${s.entity_id}|${s.state}|${s.last_changed ?? ""}`).slice(0, 16);
}

export type ControlView = {
  entityId: string;
  name: string;
  domain: string;
  state: string;
  lastChanged?: string;
  observedAt: string;
  stateToken: string;
  services: { service: string; label: string; wouldChange: boolean }[];
};

export async function listControls(): Promise<ControlView[]> {
  const rules = parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist);
  if (!rules.length) return [];
  const states = await HomeAssistantClient.states(haConn());
  const observedAt = new Date().toISOString();
  return rules.map((r) => {
    const s = states.find((x) => x.entity_id === r.entityId);
    return {
      entityId: r.entityId,
      name: String(s?.attributes.friendly_name ?? r.entityId),
      domain: r.entityId.split(".")[0]!,
      state: s?.state ?? "missing",
      lastChanged: s?.last_changed,
      observedAt,
      stateToken: s ? stateToken(s) : "missing",
      services: r.services.map((service) => ({
        service,
        label: SERVICE_LABELS[service] ?? service.replace(/_/g, " "),
        wouldChange: !(EXPECTED_RESULT[service] ?? []).includes(s?.state ?? ""),
      })),
    };
  });
}

export type ControlRequest = { entityId: string; service: string; stateToken: string; confirmed: boolean };

/**
 * Execute an allowlisted control:
 *  1. must be allowlisted and explicitly confirmed
 *  2. live state must still match what the user saw (stateToken)
 *  3. success is reported only after Home Assistant reads back the new state
 */
export async function executeControl(req: ControlRequest, actor: string, correlationId: string, opts: { readbackTimeoutMs?: number; pollMs?: number } = {}) {
  const rules = parseAllowlist(resolveIntegration("home_assistant").config.controlAllowlist);
  const rule = rules.find((r) => r.entityId === req.entityId);
  const base = { actor, action: `ha.${req.service}`, source: "home_assistant", sourceRecord: req.entityId, correlationId };
  if (!rule || !rule.services.includes(req.service)) {
    audit({ ...base, result: "rejected", detail: { reason: "not_allowlisted" } });
    throw new HttpError(403, "not_allowlisted", "That control is not in the allowlist.");
  }
  if (!req.confirmed) throw new HttpError(400, "confirmation_required", "Confirm this action first.");
  const conn = haConn();
  const live = await HomeAssistantClient.state(conn, req.entityId);
  if (stateToken(live) !== req.stateToken) {
    audit({ ...base, result: "rejected", detail: { reason: "state_changed", state: live.state } });
    throw new HttpError(409, "state_changed", `State changed to “${live.state}” since you looked. Review and confirm again.`);
  }
  const domain = req.entityId.split(".")[0]!;
  const expected = EXPECTED_RESULT[req.service];
  audit({ ...base, result: "pending", detail: { from: live.state } });
  try {
    await HomeAssistantClient.callService(conn, domain, req.service, { entity_id: req.entityId });
  } catch (err) {
    audit({ ...base, result: "error", detail: { error: (err as Error).message } });
    throw err;
  }
  const deadline = Date.now() + (opts.readbackTimeoutMs ?? 10_000);
  let current = live;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
    current = await HomeAssistantClient.state(conn, req.entityId);
    const confirmed = expected ? expected.includes(current.state) : current.state !== live.state;
    if (confirmed) {
      audit({ ...base, result: "ok", detail: { from: live.state, to: current.state } });
      return { verified: true as const, state: current.state, message: `Confirmed: ${current.state}` };
    }
  }
  audit({ ...base, result: "pending", detail: { from: live.state, to: current.state, reason: "readback_timeout" } });
  return {
    verified: false as const,
    state: current.state,
    message: `Sent to Home Assistant, but it still reports “${current.state}”. Check the device before trying again.`,
  };
}
