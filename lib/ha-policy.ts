/**
 * Home Assistant control policy (owner decision 2026-11-07: "Jarvis should be
 * able to modify garage door and home assistant devices"). Pure and
 * client-safe: the server enforces it, the House page uses it for labels,
 * risk and Undo.
 *
 * Rules:
 * - Only services listed here can ever be called, whatever the allowlist says.
 * - Every write is confirmed (a tap on a toggle, or a confirm card) and read back.
 * - Undo exists where an inverse exists (on↔off, open↔close, lock↔unlock,
 *   previous brightness / temperature / mode / volume / speed).
 * - High-risk actions (locks, alarm panels, opening a garage) need an explicit
 *   confirm step naming the device and its current state, are never low-risk
 *   for autonomy, are never executed by scheduled jobs or agents (they become
 *   a Needs-you decision instead) and are rate-limited per person.
 */

export type HaRisk = "low" | "standard" | "high";

export type ServiceDataSpec =
  | { kind: "none" }
  | { kind: "brightness" } // brightness_pct 1–100
  | { kind: "temperature" } // temperature (°, 40–95 F or 5–35 C)
  | { kind: "hvac_mode" } // hvac_mode enum
  | { kind: "percentage" } // fan percentage 0–100
  | { kind: "volume" }; // volume_level 0–1

export type ServicePolicy = { label: string; risk: HaRisk; data?: ServiceDataSpec["kind"] };

const svc = (label: string, risk: HaRisk = "low", data?: ServiceDataSpec["kind"]): ServicePolicy => ({ label, risk, data });

/** Every service Jarvis may call, per domain. Anything else is refused. */
export const HA_DOMAIN_POLICY: Record<string, Record<string, ServicePolicy>> = {
  light: { turn_on: svc("Turn on", "low", "brightness"), turn_off: svc("Turn off"), toggle: svc("Toggle") },
  switch: { turn_on: svc("Turn on", "standard"), turn_off: svc("Turn off", "standard"), toggle: svc("Toggle", "standard") },
  input_boolean: { turn_on: svc("Turn on"), turn_off: svc("Turn off"), toggle: svc("Toggle") },
  fan: { turn_on: svc("Turn on"), turn_off: svc("Turn off"), set_percentage: svc("Set speed", "low", "percentage") },
  climate: { set_temperature: svc("Set temperature", "standard", "temperature"), set_hvac_mode: svc("Set mode", "standard", "hvac_mode") },
  media_player: {
    media_play: svc("Play"),
    media_pause: svc("Pause"),
    media_stop: svc("Stop"),
    volume_set: svc("Set volume", "low", "volume"),
    turn_on: svc("Turn on"),
    turn_off: svc("Turn off"),
  },
  scene: { turn_on: svc("Activate", "standard") },
  script: { turn_on: svc("Run", "standard") },
  vacuum: { start: svc("Start"), return_to_base: svc("Send home") },
  // Covers: blinds/shades are standard; garage doors are special-cased in serviceRisk().
  cover: { open_cover: svc("Open", "standard"), close_cover: svc("Close", "standard"), stop_cover: svc("Stop", "standard") },
  lock: { lock: svc("Lock", "high"), unlock: svc("Unlock", "high"), open: svc("Open", "high") },
  alarm_control_panel: {
    alarm_arm_home: svc("Arm home", "high"),
    alarm_arm_away: svc("Arm away", "high"),
    alarm_arm_night: svc("Arm night", "high"),
    alarm_disarm: svc("Disarm", "high"),
  },
};

/** Domains whose every service is high-risk (physical security). */
export const HIGH_RISK_DOMAINS = ["lock", "alarm_control_panel"] as const;

/** Domains a person needs `home_assistant.control_doors` for; the rest need `control_lights` (devices). */
export const DOOR_DOMAINS = ["lock", "cover", "alarm_control_panel", "valve"] as const;

export const domainOf = (entityId: string) => entityId.split(".")[0] ?? "";

export function isGarage(entityId: string, deviceClass?: string | null) {
  return domainOf(entityId) === "cover" && (deviceClass === "garage" || /garage/i.test(entityId));
}

export function servicePolicy(entityId: string, service: string): ServicePolicy | undefined {
  const d = HA_DOMAIN_POLICY[domainOf(entityId)];
  return d && Object.hasOwn(d, service) ? d[service] : undefined;
}

/** low / standard / high for one call. Unknown services are treated as high (and refused elsewhere). */
export function serviceRisk(entityId: string, service: string, deviceClass?: string | null): HaRisk {
  const p = servicePolicy(entityId, service);
  if (!p) return "high";
  if (isGarage(entityId, deviceClass) && service === "open_cover") return "high";
  return p.risk;
}

export const isHighRisk = (entityId: string, service: string, deviceClass?: string | null) => serviceRisk(entityId, service, deviceClass) === "high";

/** High-risk services that make the house MORE secure (lock, arm). */
export const SECURING_SERVICES = ["lock", "close_cover", "alarm_arm_home", "alarm_arm_away", "alarm_arm_night"];

/**
 * A shared household tablet keeps the safe direction only: it may lock, close
 * and arm, never unlock, open a garage or disarm (those need a person's own sign-in).
 */
export function roleMayRun(role: string | null | undefined, entityId: string, service: string, deviceClass?: string | null) {
  if (role !== "household") return true;
  return !isHighRisk(entityId, service, deviceClass) || SECURING_SERVICES.includes(service);
}

export function controlCap(entityId: string): "home_assistant.control_doors" | "home_assistant.control_lights" {
  return (DOOR_DOMAINS as readonly string[]).includes(domainOf(entityId)) ? "home_assistant.control_doors" : "home_assistant.control_lights";
}

export const HVAC_MODES = ["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"] as const;

export type ServiceData = Record<string, string | number>;

/**
 * Validate and normalise the payload for one service. Only the documented
 * field passes; anything else is dropped. Throws Error("bad_data: …") on a bad value.
 */
export function cleanServiceData(entityId: string, service: string, data: Record<string, unknown> | undefined): ServiceData {
  const p = servicePolicy(entityId, service);
  if (!p) throw new Error("bad_data: service not allowed");
  if (!p.data || !data) return {};
  const num = (k: string, lo: number, hi: number) => {
    const v = data[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`bad_data: ${k} must be ${lo}–${hi}`);
    return n;
  };
  switch (p.data) {
    case "brightness": {
      const b = num("brightness_pct", 1, 100);
      return b === undefined ? {} : { brightness_pct: Math.round(b) };
    }
    case "percentage": {
      const b = num("percentage", 0, 100);
      return b === undefined ? {} : { percentage: Math.round(b) };
    }
    case "volume": {
      const v = num("volume_level", 0, 1);
      return v === undefined ? {} : { volume_level: Math.round(v * 100) / 100 };
    }
    case "temperature": {
      const t = num("temperature", 5, 95);
      if (t === undefined) throw new Error("bad_data: temperature is required");
      return { temperature: Math.round(t * 2) / 2 };
    }
    case "hvac_mode": {
      const m = data.hvac_mode;
      if (typeof m !== "string" || !(HVAC_MODES as readonly string[]).includes(m)) throw new Error("bad_data: unknown hvac_mode");
      return { hvac_mode: m };
    }
  }
  return {};
}

/** What a device looked like before the call: enough to compute an Undo. */
export type PriorState = {
  state: string;
  brightnessPct?: number;
  temperature?: number;
  hvacMode?: string;
  percentage?: number;
  volume?: number;
};

export type Inverse = { service: string; data?: ServiceData };

const ON_OFF: Record<string, string> = { turn_on: "turn_off", turn_off: "turn_on" };

/**
 * The call that undoes `service` given the state before it, or null when there
 * is no safe inverse (scenes, scripts, vacuum, disarm/arm with unknown prior mode, stop).
 */
export function inverseOf(entityId: string, service: string, prior: PriorState): Inverse | null {
  const domain = domainOf(entityId);
  if (!servicePolicy(entityId, service)) return null;
  if (domain === "scene" || domain === "script" || domain === "vacuum") return null;
  if (service === "toggle") return { service: "toggle" };
  if (domain === "light" && service === "turn_on" && prior.state === "on") {
    return prior.brightnessPct ? { service: "turn_on", data: { brightness_pct: prior.brightnessPct } } : null;
  }
  if (domain === "fan" && service === "set_percentage") {
    return prior.percentage !== undefined ? { service: "set_percentage", data: { percentage: prior.percentage } } : null;
  }
  if (ON_OFF[service]) {
    if (prior.state === "on" && service === "turn_off") {
      return domain === "light" && prior.brightnessPct ? { service: "turn_on", data: { brightness_pct: prior.brightnessPct } } : { service: "turn_on" };
    }
    if (prior.state === "off" && service === "turn_on") return { service: "turn_off" };
    return null;
  }
  if (service === "open_cover" && (prior.state === "closed" || prior.state === "closing")) return { service: "close_cover" };
  if (service === "close_cover" && (prior.state === "open" || prior.state === "opening")) return { service: "open_cover" };
  if (service === "lock" && prior.state === "unlocked") return { service: "unlock" };
  if (service === "unlock" && prior.state === "locked") return { service: "lock" };
  if (service === "set_temperature") return prior.temperature !== undefined ? { service, data: { temperature: prior.temperature } } : null;
  if (service === "set_hvac_mode") return prior.hvacMode ? { service, data: { hvac_mode: prior.hvacMode } } : null;
  if (service === "volume_set") return prior.volume !== undefined ? { service, data: { volume_level: prior.volume } } : null;
  if (service === "media_play" && prior.state === "paused") return { service: "media_pause" };
  if (service === "media_pause" && prior.state === "playing") return { service: "media_play" };
  if (domain === "alarm_control_panel") {
    if (service === "alarm_disarm") {
      const arm = { armed_home: "alarm_arm_home", armed_away: "alarm_arm_away", armed_night: "alarm_arm_night" }[prior.state];
      return arm ? { service: arm } : null;
    }
    if (prior.state === "disarmed") return { service: "alarm_disarm" };
  }
  return null;
}

/** States that confirm a call worked (readback). Missing = any change counts. */
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
  media_play: ["playing"],
  media_pause: ["paused"],
  media_stop: ["idle", "off", "stopped", "on"],
  start: ["cleaning"],
  return_to_base: ["returning", "docked"],
};

/** Scene / script / attribute-only services have no state to read back: the call's success is the confirmation. */
export const NO_STATE_READBACK = new Set(["scene.turn_on", "script.turn_on"]);

/** Attribute services: readback compares the attribute, not the state. */
export const ATTRIBUTE_READBACK: Record<string, (attrs: Record<string, unknown>, data: ServiceData) => boolean> = {
  "light.turn_on": (a, d) => d.brightness_pct === undefined || Math.abs(Math.round((Number(a.brightness) / 255) * 100) - Number(d.brightness_pct)) <= 2,
  "climate.set_temperature": (a, d) => Number(a.temperature) === Number(d.temperature),
  "climate.set_hvac_mode": () => true, // state itself is the mode; checked against data below
  "fan.set_percentage": (a, d) => Number(a.percentage) === Number(d.percentage),
  "media_player.volume_set": (a, d) => Math.abs(Number(a.volume_level) - Number(d.volume_level)) < 0.02,
};

/** High-risk executions per person in RATE_WINDOW_MS. */
export const HIGH_RISK_RATE = { max: 6, windowMs: 10 * 60_000 } as const;
/** All writes per person per minute (taps, sliders). */
export const WRITE_RATE = { max: 60, windowMs: 60_000 } as const;

/**
 * Who may execute: the signed-in person directly. Agents (MCP) and scheduled
 * jobs may only PROPOSE a device change (it becomes a Needs-you decision);
 * this keeps every physical change a human tap.
 */
export function actorMayExecute(via: string | null | undefined): boolean {
  return !via || !(via.startsWith("agent:") || via.startsWith("job:") || via.startsWith("schedule:"));
}

/** Left out of the default allowlist (opt-in per entity): unlatching a door. */
const NOT_DEFAULT = new Set(["lock.open"]);

/** The default allowlist: every policy domain, its services. Stored config (Settings) still overrides it. */
export const HA_POLICY_DEFAULT_CONTROLS = Object.entries(HA_DOMAIN_POLICY)
  .map(
    ([domain, s]) =>
      `${domain}.*: ${Object.keys(s)
        .filter((x) => !NOT_DEFAULT.has(`${domain}.${x}`))
        .join(", ")}`,
  )
  .join("\n");

export type AllowRule = { entityId: string; services: string[] };

/** Does a rule ("light.kitchen" or "light.*") cover this entity? */
export const ruleMatches = (rule: AllowRule, entityId: string) =>
  rule.entityId === entityId || (rule.entityId.endsWith(".*") && rule.entityId.slice(0, -2) === domainOf(entityId));

/** Allowlisted services for one entity (exact + domain wildcard), limited to what the policy permits, in policy order. */
export function allowedServicesFor(rules: AllowRule[], entityId: string): string[] {
  const want = new Set(rules.filter((r) => ruleMatches(r, entityId)).flatMap((r) => r.services));
  const policy = HA_DOMAIN_POLICY[domainOf(entityId)] ?? {};
  return Object.keys(policy).filter((s) => want.has(s));
}
