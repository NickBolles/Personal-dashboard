import { describe, expect, it } from "vitest";
import { areasHref, legacyMapHref, parseTab, readAreasUrl, tabsFor } from "@/lib/areas-view";

describe("areas view state (tabs keep the selection)", () => {
  it("parses tabs, falling back to Overview", () => {
    expect(parseTab("graph")).toBe("graph");
    expect(parseTab("board")).toBe("board");
    expect(parseTab(null)).toBe("overview");
    expect(parseTab("dependencies")).toBe("overview");
    // A task's conversation is the Chat tab; the old Chats address still opens it.
    expect(parseTab("chat")).toBe("chat");
    expect(parseTab("chats")).toBe("chat");
  });

  it("a task has one bar, Overview and Chat; an area or project keeps its views", () => {
    expect(tabsFor({ item: "t", task: true, chat: true }, "overview")).toEqual(["overview", "chat"]);
    // A note (or a person who cannot chat) has no Chat tab.
    expect(tabsFor({ item: "t", task: true, chat: false }, "overview")).toEqual(["overview"]);
    // Board and Graph are views a task can be opened in: the bar names the one that is open, so there is a way back.
    expect(tabsFor({ item: "t", task: true, chat: true }, "graph")).toEqual(["overview", "chat", "graph"]);
    expect(tabsFor({ item: "t", task: true, chat: true }, "activity")).toEqual(["overview", "chat"]);
    expect(tabsFor({ item: "p", task: false, chat: false }, "overview")).toEqual(["overview", "board", "activity", "graph"]);
    expect(tabsFor({ item: null, task: false, chat: false }, "overview")).toEqual(["overview", "portfolio", "board", "activity", "graph"]);
    expect(areasHref("/areas?item=t", { tab: "chat" })).toBe("/areas?item=t&tab=chat");
  });
  it("switching tabs keeps the selected node and other params", () => {
    const at = "https://j.test/areas?item=abc&foo=1";
    expect(areasHref(at, { tab: "graph" })).toBe("/areas?item=abc&tab=graph&foo=1");
    expect(areasHref("/areas?item=abc&tab=graph", { tab: "board" })).toBe("/areas?item=abc&tab=board");
    // Back to Overview drops the param, never the selection.
    expect(areasHref("/areas?item=abc&tab=board", { tab: "overview" })).toBe("/areas?item=abc");
  });

  it("selecting a node keeps the current tab (re-centre stays on Graph)", () => {
    expect(areasHref("/areas?item=a&tab=graph", { item: "b" })).toBe("/areas?item=b&tab=graph");
    expect(areasHref("/areas?item=a&tab=board", { item: null })).toBe("/areas?tab=board");
    expect(readAreasUrl("/areas?item=b&tab=graph")).toEqual({ item: "b", tab: "graph" });
  });

  it("a selection change drops palette actions and the legacy view", () => {
    expect(areasHref("/areas?item=a&do=packet", { item: "b" })).toBe("/areas?item=b");
    expect(areasHref("/areas?view=tree", { item: "b" })).toBe("/areas?item=b");
    // A pure tab switch on the landing keeps the phone tree view.
    expect(areasHref("/areas?view=tree", { tab: "board" })).toBe("/areas?tab=board&view=tree");
  });

  it("/areas/map redirects to the Graph tab and keeps the query", () => {
    expect(legacyMapHref({ root: "p1" })).toBe("/areas?item=p1&tab=graph");
    expect(legacyMapHref({})).toBe("/areas?tab=graph");
    expect(legacyMapHref({ root: "p1", x: "1", y: ["2", "3"] })).toBe("/areas?item=p1&tab=graph&x=1&y=2&y=3");
  });
});
