import { describe, expect, it } from "vitest";
import { autoMatchMembers, classifySkylightChore, isOwnersTask, keepAssigned, skylightPrefs, sourceFilterOptions, taskSourceLabel } from "@/lib/task-source";

const members = [
  { id: "1", name: "Nick" },
  { id: "2", name: "Sam" },
  { id: "3", name: "Family" },
  { id: "4", name: "Up for grabs" },
];

describe("skylight assignment", () => {
  it("parses prefs with defaults (up-for-grabs on, others off)", () => {
    expect(skylightPrefs({})).toEqual({ members: [], includeUpForGrabs: true, showOthers: false });
    expect(skylightPrefs({ members: "1, 2", includeUpForGrabs: "false", showOthers: "true" })).toEqual({
      members: ["1", "2"],
      includeUpForGrabs: false,
      showOthers: true,
    });
  });

  it("classifies mine, other and up for grabs", () => {
    expect(classifySkylightChore({ categoryId: "1" }, members, ["1"])).toEqual({ kind: "mine", name: "Nick" });
    expect(classifySkylightChore({ categoryId: "2" }, members, ["1"])).toEqual({ kind: "other", name: "Sam" });
    expect(classifySkylightChore({ categoryId: null }, members, ["1"]).kind).toBe("up_for_grabs");
    expect(classifySkylightChore({ categoryId: "4" }, members, ["1"]).kind).toBe("up_for_grabs");
    expect(classifySkylightChore({ categoryId: "2", upForGrabs: true }, members, ["1"]).kind).toBe("up_for_grabs");
    // Household category is not up for grabs: hidden unless showOthers.
    expect(classifySkylightChore({ categoryId: "3" }, members, ["1"]).kind).toBe("other");
  });

  it("filters by prefs; unconfigured shows everything", () => {
    const prefs = skylightPrefs({ members: "1" });
    expect(keepAssigned({ kind: "mine" }, prefs)).toBe(true);
    expect(keepAssigned({ kind: "up_for_grabs" }, prefs)).toBe(true);
    expect(keepAssigned({ kind: "other" }, prefs)).toBe(false);
    expect(keepAssigned({ kind: "up_for_grabs" }, { ...prefs, includeUpForGrabs: false })).toBe(false);
    expect(keepAssigned({ kind: "other" }, { ...prefs, showOthers: true })).toBe(true);
    expect(keepAssigned({ kind: "other" }, skylightPrefs({}))).toBe(true);
  });

  it("auto-matches the owner only on a unique name match", () => {
    expect(autoMatchMembers(members, { name: "Nick Bolles" })).toEqual(["1"]);
    expect(autoMatchMembers(members, { email: "sam.smith@example.com" })).toEqual(["2"]);
    expect(autoMatchMembers(members, { name: "Alex" })).toEqual([]);
    expect(autoMatchMembers([...members, { id: "9", name: "Nick" }], { name: "Nick" })).toEqual([]);
    expect(autoMatchMembers(members, { name: "Up" })).toEqual([]);
  });

  it("overdue context keeps owner + up-for-grabs + unassigned sources", () => {
    expect(isOwnersTask({})).toBe(true);
    expect(isOwnersTask({ assignee: { kind: "up_for_grabs" } })).toBe(true);
    expect(isOwnersTask({ assignee: { kind: "other", name: "Sam" } })).toBe(false);
  });
});

describe("source labels", () => {
  it("prefers the adapter label and falls back to the source name", () => {
    expect(taskSourceLabel({ source: "todos", sourceLabel: "Google Tasks · Groceries" })).toBe("Google Tasks · Groceries");
    expect(taskSourceLabel({ source: "daily_compass" })).toBe("Daily Compass");
    expect(
      sourceFilterOptions([
        { source: "skylight", sourceLabel: "Skylight · Chores" },
        { source: "todos", sourceLabel: "Jarvis" },
        { source: "skylight", sourceLabel: "Skylight · Chores" },
      ]),
    ).toEqual(["Jarvis", "Skylight · Chores"]);
  });
});
