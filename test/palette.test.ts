import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  PALETTE_STATUSES,
  actionById,
  candidatesFor,
  confirmText,
  fillAll,
  fillChip,
  isComplete,
  matchActions,
  prUrlFor,
  pushRecent,
  rankSuggestions,
  splitArgs,
  type PaletteContext,
} from "@/lib/palette";

const ctx: PaletteContext = {
  areas: [
    { id: "a-home", label: "Home" },
    { id: "a-mom", label: "Momentum bets" },
    { id: "a-misc", label: "Miscellaneous" },
  ],
  items: [
    { id: "i-gutter", label: "Fix gutter", detail: "Home" },
    { id: "i-hyd", label: "Hydration fix", detail: "Momentum bets" },
  ],
  agents: [
    { id: "jarvis", label: "Jarvis" },
    { id: "momentumchief", label: "momentumchief" },
  ],
};

describe("palette: action parsing", () => {
  it("matches a typed phrase and keeps the rest as argument text", () => {
    const [m] = matchActions("New item in Ho");
    expect(m!.def.id).toBe("new-item");
    expect(m!.exact).toBe(true);
    expect(m!.rest).toBe("Ho");
  });
  it("keeps the typed casing of argument text (#103)", () => {
    expect(matchActions("new item in Home Fix API_KEY")[0]!.rest).toBe("Home Fix API_KEY");
    expect(matchActions("/new Home Explain MyClass")[0]!.rest).toBe("Home Explain MyClass");
    expect(matchActions("NEW ITEM IN Home")[0]!.exact).toBe(true);
  });
  it("matches a phrase prefix (2+ letters) without arguments", () => {
    expect(matchActions("new it").map((m) => m.def.id)).toContain("new-item");
    expect(matchActions("a")).toEqual([]);
  });
  it("leaves out context-bound actions when there's nothing to act on", () => {
    expect(matchActions("set status").map((m) => m.def.id)).not.toContain("status");
    expect(matchActions("set status", { item: true }).map((m) => m.def.id)).toContain("status");
  });
  it("/ lists every usable action; /mo filters by command name", () => {
    expect(matchActions("/", { item: true, area: true })).toHaveLength(ACTIONS.length);
    expect(matchActions("/mo").map((m) => m.def.id)).toEqual(["move"]);
    const [pr] = matchActions("/pr 42");
    expect(pr).toMatchObject({ exact: true, rest: "42" });
  });
  it("splits arguments at joiner words", () => {
    expect(splitArgs(actionById("move").args, "hydration fix to momentum")).toEqual(["hydration fix", "momentum"]);
    expect(splitArgs(actionById("move").args, "hydration")).toEqual(["hydration", ""]);
  });
});

describe("palette: argument chips", () => {
  it("Tab fills the current chip with the best candidate, then the text argument", () => {
    const def = actionById("new-item");
    const one = fillChip(def, [], "ho", ctx)!;
    expect(one.chips.map((c) => c.value.id)).toEqual(["a-home"]);
    expect(isComplete(def, one.chips)).toBe(false);
    const two = fillChip(def, one.chips, "Clean filters", ctx)!;
    expect(two.chips[1]!.value.label).toBe("Clean filters");
    expect(isComplete(def, two.chips)).toBe(true);
    expect(confirmText(def, two.chips)).toBe("Create “Clean filters” in Home?");
  });
  it("Tab does nothing when nothing matches", () => {
    expect(fillChip(actionById("new-item"), [], "zzz", ctx)).toBeNull();
  });
  it("fills chips from one typed sentence (longest area name, rest = title)", () => {
    const r = fillAll(actionById("new-item"), "momentum bets ship v5", ctx);
    expect(r.chips.map((c) => c.value.id)).toEqual(["a-mom"]);
    expect(r.input).toBe("ship v5");
    const mv = fillAll(actionById("move"), "gutter to momentum", ctx);
    expect(mv.chips.map((c) => c.value.id)).toEqual(["i-gutter", "a-mom"]);
  });
  it("PR numbers and agents", () => {
    expect(candidatesFor("pr", "#123", ctx)).toEqual([{ id: "123", label: "#123" }]);
    expect(candidatesFor("pr", "abc", ctx)).toEqual([]);
    expect(candidatesFor("agent", "@mom", ctx)[0]!.id).toBe("momentumchief");
  });
  it("never offers settling (or any closing status) as a status", () => {
    for (const s of ["settled", "ready_to_settle", "superseded", "abandoned", "reopened"]) expect(PALETTE_STATUSES).not.toContain(s);
    expect(candidatesFor("status", "sett", ctx)).toEqual([]);
  });
  it("every write action needs a confirm step", () => {
    for (const id of ["new-item", "move", "assign", "status"] as const) expect(actionById(id).write).toBe(true);
  });
});

describe("palette: suggestions", () => {
  it("on an item: status and move first", () => {
    const s = rankSuggestions({ kind: "item", path: "/areas", nodeTitle: "Fix gutter", areaTitle: "Home" }, [], { item: true, area: true });
    expect(s.slice(0, 2).map((x) => x.action)).toEqual(["status", "move"]);
    expect(s.find((x) => x.action === "ask")!.label).toBe("Ask Home");
  });
  it("on an area: New item in <area> first", () => {
    const s = rankSuggestions({ kind: "area", path: "/areas", nodeTitle: "Home", isContainer: true }, [], { area: true });
    expect(s[0]).toMatchObject({ action: "new-item", label: "New item in Home" });
  });
  it("in chat: start chat with @agent; inbox: move first", () => {
    expect(rankSuggestions({ kind: "chat", path: "/chat/x" })[0]!.action).toBe("chat-agent");
    expect(rankSuggestions({ kind: "page", path: "/inbox" })[0]!.action).toBe("move");
  });
  it("recently used actions get a boost", () => {
    const s = rankSuggestions({ kind: "page", path: "/home" }, ["open-pr"]);
    expect(s[0]!.action).toBe("open-pr");
  });
  it("recent list dedupes and caps", () => {
    let l = pushRecent([], { id: "x", title: "X", at: 1 });
    l = pushRecent(l, { id: "y", title: "Y", at: 2 });
    l = pushRecent(l, { id: "x", title: "X", at: 3 }, 2);
    expect(l.map((e) => e.id)).toEqual(["x", "y"]);
  });
});

describe("prUrlFor", () => {
  it("prefers the PR linked to your work, then any PR, then search", () => {
    const opts = [
      { id: "a/b#12", detail: "Issue · open" },
      { id: "x/y#12", detail: "PR · merged" },
      { id: "NickBolles/Personal-dashboard#12", detail: "PR · open · linked" },
      { id: "x/y#120", detail: "PR · open · linked" },
    ];
    expect(prUrlFor("12", opts)).toBe("https://github.com/NickBolles/Personal-dashboard/pull/12");
    expect(prUrlFor("12", opts.slice(0, 2))).toBe("https://github.com/x/y/pull/12");
    expect(prUrlFor("12", opts.slice(0, 1))).toBe("https://github.com/a/b/issues/12");
    expect(prUrlFor("7", opts)).toBe("https://github.com/search?q=%237&type=pullrequests");
  });
});
