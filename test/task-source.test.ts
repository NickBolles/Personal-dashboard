import { describe, expect, it } from "vitest";
import {
  autoGroupMembers as autoAll,
  autoMatchMembers,
  classifySkylightChore,
  groupMemberIds,
  isOwnersTask,
  keepAssigned,
  skylightPrefs,
  sourceFilterOptions,
  taskSourceLabel,
} from "@/lib/task-source";

const members = [
  { id: "1", name: "Nick" },
  { id: "2", name: "Sam" },
  { id: "3", name: "Family" },
  { id: "4", name: "Up for grabs" },
];

describe("skylight assignment", () => {
  it("parses prefs with defaults (up-for-grabs on, others off)", () => {
    expect(skylightPrefs({})).toEqual({ members: [], includeUpForGrabs: true, showOthers: false, groups: null });
    expect(skylightPrefs({ members: "1, 2", includeUpForGrabs: "false", showOthers: "true" })).toEqual({
      members: ["1", "2"],
      includeUpForGrabs: false,
      showOthers: true,
      groups: null,
    });
    expect(skylightPrefs({ groups: "none" }).groups).toEqual([]);
    expect(skylightPrefs({ groups: " auto " }).groups).toBeNull();
    expect(skylightPrefs({ groups: "3, 7" }).groups).toEqual(["3", "7"]);
  });

  it("classifies mine, other and up for grabs", () => {
    expect(classifySkylightChore({ categoryId: "1" }, members, ["1"])).toEqual({ kind: "mine", name: "Nick" });
    expect(classifySkylightChore({ categoryId: "2" }, members, ["1"])).toEqual({ kind: "other", name: "Sam" });
    expect(classifySkylightChore({ categoryId: null }, members, ["1"]).kind).toBe("up_for_grabs");
    expect(classifySkylightChore({ categoryId: "4" }, members, ["1"]).kind).toBe("up_for_grabs");
    expect(classifySkylightChore({ categoryId: "2", upForGrabs: true }, members, ["1"]).kind).toBe("up_for_grabs");
    // Without groups a household category is someone else's.
    expect(classifySkylightChore({ categoryId: "3" }, members, ["1"]).kind).toBe("other");
  });

  it("treats household groups (Family*) as up for grabs", () => {
    const all = [...members, { id: "5", name: "Family Chores" }, { id: "6", name: "Kids", isGroup: true }, { id: "7", name: "Familyman" }];
    const auto = groupMemberIds(all, skylightPrefs({}));
    expect(auto).toEqual(["3", "5", "6"]);
    expect(classifySkylightChore({ categoryId: "3" }, all, ["1"], auto)).toEqual({ kind: "up_for_grabs", name: "Up for grabs" });
    expect(classifySkylightChore({ categoryId: "6" }, all, ["1"], auto).kind).toBe("up_for_grabs");
    expect(classifySkylightChore({ categoryId: "7" }, all, ["1"], auto).kind).toBe("other");
    expect(classifySkylightChore({ categoryId: "2" }, all, ["1"], auto).kind).toBe("other");
    // Owner override: explicit list / none.
    expect(groupMemberIds(all, skylightPrefs({ groups: "2" }))).toEqual(["2"]);
    expect(groupMemberIds(all, skylightPrefs({ groups: "none" }))).toEqual([]);
    expect(classifySkylightChore({ categoryId: "3" }, all, ["1"], [])).toEqual({ kind: "other", name: "Family" });
    // Kept only when "Include up-for-grabs" is on.
    const ufg = classifySkylightChore({ categoryId: "3" }, all, ["1"], auto);
    expect(keepAssigned(ufg, skylightPrefs({ members: "1" }))).toBe(true);
    expect(keepAssigned(ufg, skylightPrefs({ members: "1", includeUpForGrabs: "false" }))).toBe(false);
    // Groups are never auto-matched as the owner.
    expect(autoMatchMembers([{ id: "5", name: "Family" }], { name: "Family" })).toEqual([]);
    expect(autoAll(all)).toEqual(["3", "5", "6"]);
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
