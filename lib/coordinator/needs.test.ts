import { describe, expect, it } from "vitest";
import { ageLabel, decisionKeyAction, defaultLine, deferUntil, isRisky, nextAfterAnswer, pagerState, recommendedChoice, safeEvidenceHref } from "./needs";
import { RISK_FLAGS } from "@/lib/cw-decisions";

const list = [{ ref: "D-48" }, { ref: "D-49" }, { ref: "D-50" }];
const now = Date.parse("2026-11-08T12:00:00Z");
describe("decision pager", () => {
  it("has a zero-based index and non-wrapping neighbours", () => {
    expect(pagerState(list, "D-48")).toEqual({ index: 0, total: 3, prev: null, next: "D-49" });
    expect(pagerState(list, "D-49")).toEqual({ index: 1, total: 3, prev: "D-48", next: "D-50" });
    expect(pagerState(list, "D-50")).toEqual({ index: 2, total: 3, prev: "D-49", next: null });
  });
  it("handles missing refs and empty lists", () => {
    expect(pagerState([], "D-48")).toEqual({ index: -1, total: 0, prev: null, next: null });
    expect(pagerState(list, "D-1").next).toBeNull();
  });
  it("advances after answering, falls back to the previous row or the refreshed head", () => {
    expect(nextAfterAnswer(list, "D-48")).toBe("D-49");
    expect(nextAfterAnswer(list, "D-50")).toBe("D-49");
    expect(nextAfterAnswer(list.slice(1), "D-48")).toBe("D-49");
    expect(nextAfterAnswer(list.slice(0, 1), "D-48")).toBeNull();
    expect(nextAfterAnswer([], "D-48")).toBeNull();
    expect(list.map((d) => d.ref)).toEqual(["D-48", "D-49", "D-50"]);
  });
});
describe("age and defaults", () => {
  it("formats minutes, hours and days without a wall-clock dependency", () => {
    expect(ageLabel("2026-11-08T10:00:00Z", now)).toBe("2 h");
    expect(ageLabel("2026-11-05T12:00:00Z", new Date(now))).toBe("3 d");
    expect(ageLabel("2026-11-08T11:30:00Z", now)).toBe("30 min");
    expect(ageLabel("2026-11-08T13:00:00Z", now)).toBe("1 min");
    expect(ageLabel("bad-date", now)).toBe("Unknown age");
  });
  const base = { risk: [], defaultChoice: "Accept", expiresAt: "2026-11-08T15:00:00Z" };
  it("formats an upcoming safe default and an elapsed one", () => {
    expect(defaultLine(base, now)).toBe("No answer in 3 h → Accept");
    expect(defaultLine({ ...base, expiresAt: "2026-11-08T11:00:00Z" }, now)).toBe("No answer → Accept now");
    expect(defaultLine({ ...base, expiresAt: "2026-11-11T12:00:00Z" }, now)).toBe("No answer in 3 d → Accept");
  });
  it("never offers a risky, incomplete or invalid default", () => {
    for (const risk of RISK_FLAGS) expect(defaultLine({ ...base, risk: [risk] }, now)).toBeNull();
    expect(defaultLine({ ...base, defaultChoice: null }, now)).toBeNull();
    expect(defaultLine({ ...base, expiresAt: null }, now)).toBeNull();
    expect(defaultLine({ ...base, expiresAt: "invalid" }, now)).toBeNull();
  });
  it("uses the actual risk array, not the recommended answer", () => {
    expect(isRisky({ risk: [] })).toBe(false);
    for (const flag of RISK_FLAGS) expect(isRisky({ risk: [flag] })).toBe(true);
  });
});
describe("recommended answer", () => {
  it("is the agent's valid recommendation, and never the first option standing in for one", () => {
    expect(recommendedChoice({ choices: ["No", "Yes"], recommended: "Yes" })).toBe("Yes");
    expect(recommendedChoice({ choices: ["No", "Yes"], recommended: "Maybe" })).toBeNull();
    expect(recommendedChoice({ choices: ["No"], recommended: null })).toBeNull();
    expect(recommendedChoice({ choices: [], recommended: "Yes" })).toBeNull();
  });
});
describe("scoped keyboard actions", () => {
  it.each([
    ["j", "next"],
    ["k", "prev"],
    ["1", "pick-1"],
    ["2", "pick-2"],
    ["3", "pick-3"],
    ["4", "pick-4"],
    ["Escape", "back"],
    ["Esc", "back"],
    ["d", "defer"],
    ["a", "ask"],
  ])("maps %s to %s", (key, action) => {
    expect(decisionKeyAction(key, {})).toBe(action);
    expect(decisionKeyAction(key, { typing: true, armed: true, canUndo: true })).toBeNull();
  });
  it("guards Enter and Undo, and ignores unknown keys", () => {
    expect(decisionKeyAction("Enter", { armed: true })).toBe("confirm");
    expect(decisionKeyAction("Enter", {})).toBeNull();
    expect(decisionKeyAction("u", { canUndo: true })).toBe("undo");
    expect(decisionKeyAction("u", {})).toBeNull();
    expect(decisionKeyAction("Enter", { armed: true, typing: true })).toBeNull();
    expect(decisionKeyAction("u", { canUndo: true, typing: true })).toBeNull();
    expect(decisionKeyAction("5", {})).toBeNull();
  });
});
describe("defer dates and evidence", () => {
  it("chooses an hour ahead and tomorrow at local 9am", () => {
    const local = new Date(2026, 10, 8, 22, 35);
    expect(Date.parse(deferUntil("hour", local)) - local.getTime()).toBe(3_600_000);
    const tomorrow = new Date(deferUntil("tomorrow", local));
    expect(tomorrow.getDate()).toBe(9);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/plain,hello",
    "//evil.test",
    "/\\evil.test",
    "https://",
    "http://example.test",
    "https://u:p@example.test",
    "/bad path",
    "https://good.test\\@evil.test",
  ])("rejects unsafe evidence: %s", (href) => {
    expect(safeEvidenceHref(href)).toBeNull();
  });
  it("keeps literal safe links without normalizing them", () => {
    expect(safeEvidenceHref("/areas?item=a#detail")).toBe("/areas?item=a#detail");
    expect(safeEvidenceHref("https://example.test/pr/2")).toBe("https://example.test/pr/2");
    expect(safeEvidenceHref()).toBeNull();
  });
});
