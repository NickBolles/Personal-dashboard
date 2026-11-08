/**
 * Home Assistant control policy (owner decision 2026-11-07): what Jarvis may
 * call per domain, which calls are high-risk, and how each one is undone.
 */
import { describe, expect, it } from "vitest";
import {
  HA_DOMAIN_POLICY,
  HA_POLICY_DEFAULT_CONTROLS,
  actorMayExecute,
  allowedServicesFor,
  cleanServiceData,
  controlCap,
  inverseOf,
  isHighRisk,
  isPoweredOff,
  isPoweredOn,
  roleMayRun,
  serviceRisk,
} from "@/lib/ha-policy";

const parse = (v: string) =>
  v
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [e, s] = l.split(":");
      return { entityId: e!.trim(), services: s!.split(",").map((x) => x.trim()) };
    });

describe("policy matrix", () => {
  const matrix: [string, string, "low" | "standard" | "high"][] = [
    ["light.kitchen", "turn_on", "low"],
    ["light.kitchen", "turn_off", "low"],
    ["light.kitchen", "toggle", "low"],
    ["switch.coffee", "turn_on", "standard"],
    ["input_boolean.guest", "toggle", "low"],
    ["fan.bedroom", "set_percentage", "low"],
    ["climate.thermostat", "set_temperature", "standard"],
    ["climate.thermostat", "set_hvac_mode", "standard"],
    ["media_player.speaker", "volume_set", "low"],
    ["scene.movie", "turn_on", "standard"],
    ["script.goodnight", "turn_on", "standard"],
    ["vacuum.roomba", "start", "low"],
    ["vacuum.roomba", "return_to_base", "low"],
    ["cover.blinds", "open_cover", "standard"],
    ["cover.garage_door", "close_cover", "standard"],
    ["cover.garage_door", "open_cover", "high"],
    ["lock.front_door_lock", "lock", "high"],
    ["lock.front_door_lock", "unlock", "high"],
    ["alarm_control_panel.house", "alarm_disarm", "high"],
    ["alarm_control_panel.house", "alarm_arm_away", "high"],
  ];
  it.each(matrix)("%s %s is %s", (entity, service, risk) => {
    expect(serviceRisk(entity, service)).toBe(risk);
  });

  it("a garage named without 'garage' is still high-risk to open when HA says device_class garage", () => {
    expect(serviceRisk("cover.door_2", "open_cover")).toBe("standard");
    expect(serviceRisk("cover.door_2", "open_cover", "garage")).toBe("high");
  });

  it("services outside the matrix are refused (treated as high and never allowlisted)", () => {
    expect(serviceRisk("shell_command.rm", "run")).toBe("high");
    expect(allowedServicesFor(parse("shell_command.*: run\nlight.*: turn_on, set_color_temp"), "shell_command.rm")).toEqual([]);
    expect(allowedServicesFor(parse("light.*: turn_on, set_color_temp"), "light.kitchen")).toEqual(["turn_on"]);
  });

  it("door/lock/alarm domains need the door capability; everything else the device one", () => {
    expect(controlCap("lock.x")).toBe("home_assistant.control_doors");
    expect(controlCap("cover.garage_door")).toBe("home_assistant.control_doors");
    expect(controlCap("alarm_control_panel.x")).toBe("home_assistant.control_doors");
    expect(controlCap("light.x")).toBe("home_assistant.control_lights");
    expect(controlCap("climate.x")).toBe("home_assistant.control_lights");
  });
});

describe("default allowlist", () => {
  const rules = parse(HA_POLICY_DEFAULT_CONTROLS);
  it("covers every policy domain, garage open + close (#219) and lock/unlock, but not unlatching", () => {
    for (const d of Object.keys(HA_DOMAIN_POLICY)) expect(rules.some((r) => r.entityId === `${d}.*`)).toBe(true);
    expect(allowedServicesFor(rules, "cover.garage_door")).toEqual(["open_cover", "close_cover", "stop_cover"]);
    expect(allowedServicesFor(rules, "lock.front_door_lock")).toEqual(["lock", "unlock"]);
    expect(allowedServicesFor(rules, "light.porch")).toEqual(["turn_on", "turn_off", "toggle"]);
  });
  it("exact rules and wildcards combine", () => {
    expect(allowedServicesFor(parse("lock.front: lock\nlock.*: unlock"), "lock.front")).toEqual(["lock", "unlock"]);
    expect(allowedServicesFor(parse("lock.front: lock"), "lock.back")).toEqual([]);
  });
});

describe("inverse / Undo mapping", () => {
  it.each([
    ["light.k", "turn_on", { state: "off" }, { service: "turn_off" }],
    ["light.k", "turn_off", { state: "on", brightnessPct: 40 }, { service: "turn_on", data: { brightness_pct: 40 } }],
    ["light.k", "turn_on", { state: "on", brightnessPct: 80 }, { service: "turn_on", data: { brightness_pct: 80 } }],
    ["switch.c", "turn_off", { state: "on" }, { service: "turn_on" }],
    ["light.k", "toggle", { state: "on" }, { service: "toggle" }],
    ["cover.garage_door", "close_cover", { state: "open" }, { service: "open_cover" }],
    ["cover.garage_door", "open_cover", { state: "closed" }, { service: "close_cover" }],
    ["lock.f", "unlock", { state: "locked" }, { service: "lock" }],
    ["lock.f", "lock", { state: "unlocked" }, { service: "unlock" }],
    ["climate.t", "set_temperature", { state: "heat", temperature: 68 }, { service: "set_temperature", data: { temperature: 68 } }],
    ["climate.t", "set_hvac_mode", { state: "heat", hvacMode: "heat" }, { service: "set_hvac_mode", data: { hvac_mode: "heat" } }],
    ["fan.b", "set_percentage", { state: "on", percentage: 50 }, { service: "set_percentage", data: { percentage: 50 } }],
    ["media_player.s", "volume_set", { state: "paused", volume: 0.3 }, { service: "volume_set", data: { volume_level: 0.3 } }],
    ["media_player.s", "media_play", { state: "paused" }, { service: "media_pause" }],
    ["alarm_control_panel.h", "alarm_disarm", { state: "armed_away" }, { service: "alarm_arm_away" }],
    ["alarm_control_panel.h", "alarm_arm_home", { state: "disarmed" }, { service: "alarm_disarm" }],
  ] as const)("%s %s from %j → %j", (entity, service, prior, inverse) => {
    expect(inverseOf(entity, service, prior)).toEqual(inverse);
  });

  it.each([
    ["scene.movie", "turn_on", { state: "scening" }],
    ["script.goodnight", "turn_on", { state: "off" }],
    ["vacuum.r", "start", { state: "docked" }],
    ["light.k", "turn_on", { state: "on" }], // no prior brightness: nothing to go back to
    ["cover.garage_door", "close_cover", { state: "closed" }], // no change, nothing to undo
    ["alarm_control_panel.h", "alarm_disarm", { state: "triggered" }],
  ] as const)("%s %s from %j has no Undo", (entity, service, prior) => {
    expect(inverseOf(entity, service, prior)).toBeNull();
  });

  it("garage Close and Open are each other's Undo, and reopening stays high-risk", () => {
    const undoClose = inverseOf("cover.garage_door", "close_cover", { state: "open" })!;
    expect(isHighRisk("cover.garage_door", undoClose.service)).toBe(true);
    const undoOpen = inverseOf("cover.garage_door", "open_cover", { state: "closed" })!;
    expect(isHighRisk("cover.garage_door", undoOpen.service)).toBe(false);
  });
});

describe("shared household tablet (owner decision 2026-11-07)", () => {
  it("may open/close garages and lock/unlock doors, never disarm or unlatch", () => {
    const t = (e: string, svc: string, dc?: string) => roleMayRun("household", e, svc, dc);
    expect(t("cover.garage_door", "open_cover")).toBe(true);
    expect(t("cover.big_door", "open_cover", "garage")).toBe(true);
    expect(t("cover.garage_door", "close_cover")).toBe(true);
    expect(t("lock.front_door_lock", "lock")).toBe(true);
    expect(t("lock.front_door_lock", "unlock")).toBe(true);
    expect(t("lock.front_door_lock", "open")).toBe(false);
    expect(t("alarm_control_panel.home", "alarm_arm_away")).toBe(true);
    expect(t("alarm_control_panel.home", "alarm_disarm")).toBe(false);
    expect(t("light.kitchen", "turn_on")).toBe(true);
    // still high-risk: the tablet goes through the explicit confirm card like everyone else
    expect(isHighRisk("cover.garage_door", "open_cover")).toBe(true);
    expect(isHighRisk("lock.front_door_lock", "unlock")).toBe(true);
    // signed-in people are unaffected
    expect(roleMayRun("adult", "alarm_control_panel.home", "alarm_disarm")).toBe(true);
  });
});

describe("high-risk gating", () => {
  it("only signed-in people execute; agents and scheduled jobs must propose", () => {
    expect(actorMayExecute(null)).toBe(true);
    expect(actorMayExecute(undefined)).toBe(true);
    expect(actorMayExecute("agent:devchief")).toBe(false);
    expect(actorMayExecute("job:morning")).toBe(false);
    expect(actorMayExecute("schedule:weekly")).toBe(false);
  });
});

describe("service data", () => {
  it("keeps only the documented field, in range", () => {
    expect(cleanServiceData("light.k", "turn_on", { brightness_pct: 55.4, color: "red" })).toEqual({ brightness_pct: 55 });
    expect(cleanServiceData("light.k", "turn_off", { brightness_pct: 10 })).toEqual({});
    expect(cleanServiceData("climate.t", "set_temperature", { temperature: 70.3 })).toEqual({ temperature: 70.5 });
    expect(cleanServiceData("climate.t", "set_hvac_mode", { hvac_mode: "cool" })).toEqual({ hvac_mode: "cool" });
    expect(cleanServiceData("media_player.s", "volume_set", { volume_level: 0.456 })).toEqual({ volume_level: 0.46 });
  });
  it("rejects out-of-range and unknown values", () => {
    expect(() => cleanServiceData("light.k", "turn_on", { brightness_pct: 0 })).toThrow(/bad_data/);
    expect(() => cleanServiceData("climate.t", "set_temperature", { temperature: 400 })).toThrow(/bad_data/);
    expect(() => cleanServiceData("climate.t", "set_temperature", {})).toThrow(/bad_data/);
    expect(() => cleanServiceData("climate.t", "set_hvac_mode", { hvac_mode: "sauna" })).toThrow(/bad_data/);
    expect(() => cleanServiceData("fan.b", "set_percentage", { percentage: "x" })).toThrow(/bad_data/);
  });
  it("#241: temperature / hvac_mode are required even when no data is sent", () => {
    expect(() => cleanServiceData("climate.t", "set_temperature", undefined)).toThrow(/temperature is required/);
    expect(() => cleanServiceData("climate.t", "set_hvac_mode", undefined)).toThrow(/hvac_mode/);
    // optional payloads stay optional
    expect(cleanServiceData("light.k", "turn_on", undefined)).toEqual({});
    expect(cleanServiceData("media_player.s", "turn_off", undefined)).toEqual({});
  });
});

describe("media player power (#246)", () => {
  it("paused / idle / playing players are powered on; off / standby are off", () => {
    for (const s of ["playing", "paused", "idle", "on", "buffering"]) expect(isPoweredOn("media_player.tv", s)).toBe(true);
    for (const s of ["off", "standby", "unavailable", "unknown"]) expect(isPoweredOn("media_player.tv", s)).toBe(false);
    expect(isPoweredOff("media_player.tv", "standby")).toBe(true);
    expect(isPoweredOff("media_player.tv", "unavailable")).toBe(false);
    expect(isPoweredOn("switch.x", "paused")).toBe(false);
  });
  it("turning off a paused player can be undone", () => {
    expect(inverseOf("media_player.tv", "turn_off", { state: "paused" })).toEqual({ service: "turn_on" });
    expect(inverseOf("media_player.tv", "turn_on", { state: "standby" })).toEqual({ service: "turn_off" });
  });
});
