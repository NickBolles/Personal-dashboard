// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { digest, treeCounts } from "@/lib/areas-digest";
import { todayIso, type WorkItem } from "@/lib/work";
import { BoardTab } from "@/components/areas/BoardTab";
import { MAP_KEY, MapView, type MapResponse } from "@/components/map/MapView";
import { WorkTree } from "@/components/work/WorkTree";
import { api } from "@/lib/client/api";
import type { DecisionsResponse } from "@/lib/decisions";

vi.mock("@/components/agents/CoordinatorPane", () => ({ CoordinatorButton: () => null }));

const decision = { question: "Proceed?", choices: [], askedAt: "2026-11-05T00:00:00Z" };
function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    parentId: "p",
    kind: "thread",
    title: id,
    summary: "",
    nextAction: "Next step",
    status: "captured",
    sortOrder: 0,
    startDate: null,
    targetDate: null,
    completedAt: null,
    settledKind: null,
    settledReason: null,
    archived: false,
    builtIn: false,
    validationDefault: null,
    sessionId: null,
    settings: null,
    tags: [],
    assignee: null,
    decision: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}
const containers = () => [item("a", { parentId: null, kind: "area", title: "Area" }), item("p", { parentId: "a", kind: "project", title: "Project" })];
const today = "2026-11-06";

describe("digest", () => {
  it("orders in flight newest first, caps at five and preserves totals and paths", () => {
    const work = Array.from({ length: 7 }, (_, n) => item(`i${n}`, { status: "in_progress", updatedAt: `2026-11-0${n + 1}T00:00:00Z` }));
    const result = digest([...containers(), ...work], today);
    expect(result.inflight.map((r) => r.id)).toEqual(["i6", "i5", "i4", "i3", "i2"]);
    expect(result.inflightTotal).toBe(7);
    expect(result.inflight[0]).toEqual({
      id: "i6",
      title: "i6",
      path: "Area · Project",
      reason: "inflight",
      nextAction: "Next step",
      updatedAt: "2026-11-07T00:00:00Z",
    });
  });

  it("orders owner before overdue before next; overdue ready work appears once", () => {
    const result = digest(
      [
        ...containers(),
        item("next", { status: "ready", updatedAt: "2026-11-06" }),
        item("overdue", { status: "ready", targetDate: "2026-11-05" }),
        item("owner", { decision, targetDate: "2026-11-01" }),
        item("owner-new", { decision, updatedAt: "2026-11-04" }),
      ],
      today,
    );
    expect(result.outstanding.map((r) => [r.id, r.reason])).toEqual([
      ["owner-new", "needs_you"],
      ["owner", "needs_you"],
      ["overdue", "overdue"],
      ["next", "next"],
    ]);
    expect(result.outstandingTotal).toBe(4);
  });

  it("caps outstanding independently and retains its full total", () => {
    const result = digest(
      Array.from({ length: 8 }, (_, n) => item(`i${n}`, { status: "ready" })),
      today,
    );
    expect(result.outstanding).toHaveLength(5);
    expect(result.outstandingTotal).toBe(8);
  });

  it.each(["settled", "superseded", "abandoned"] as const)("excludes %s items even when overdue or awaiting a decision", (status) => {
    expect(digest([item("closed", { status, decision, targetDate: "2020-01-01" })], today).outstandingTotal).toBe(0);
  });

  it("excludes containers, conversations and archived work from both lists", () => {
    const excluded = [
      ...containers().map((i) => ({ ...i, status: "in_progress" as const, targetDate: "2020-01-01" })),
      item("chat", { kind: "conversation", status: "in_progress", decision, targetDate: "2020-01-01" }),
      item("archived", { archived: true, status: "in_progress", targetDate: "2020-01-01" }),
    ];
    expect(digest(excluded, today)).toEqual({ inflight: [], outstanding: [], inflightTotal: 0, outstandingTotal: 0 });
  });

  it("detects overdue using a strictly earlier local calendar date (not due today or future)", () => {
    const localToday = todayIso(new Date(2026, 10, 6, 0, 1));
    const result = digest(
      [
        item("yesterday", { targetDate: "2026-11-05" }),
        item("today", { targetDate: "2026-11-06" }),
        item("future", { targetDate: "2026-11-07" }),
        item("undated"),
      ],
      localToday,
    );
    expect(result.outstanding.map((r) => r.id)).toEqual(["yesterday"]);
  });

  it("includes overdue in-flight work in both sections and ignores conversation ancestors in paths", () => {
    const result = digest(
      [...containers(), item("chat", { kind: "conversation" }), item("work", { parentId: "chat", status: "in_review", targetDate: "2026-11-05" })],
      today,
    );
    expect(result.inflight[0].path).toBe("Area · Project");
    expect(result.outstanding[0].reason).toBe("overdue");
  });

  it("handles missing parents and cycles without mutating the input", () => {
    const items = [
      item("x", { parentId: "missing", status: "ready" }),
      item("p1", { kind: "project", parentId: "p2" }),
      item("p2", { kind: "project", parentId: "p1" }),
      item("y", { parentId: "p1", status: "ready" }),
    ];
    const before = structuredClone(items);
    expect(digest(items, today).outstanding).toHaveLength(2);
    expect(items).toEqual(before);
  });
});

describe("treeCounts", () => {
  it("aggregates nested projects and work descendants without counting containers or conversations", () => {
    const counts = treeCounts([
      ...containers(),
      item("sub", { kind: "project" }),
      item("owner", { parentId: "sub", decision }),
      item("flight", { status: "in_progress" }),
      item("nested", { parentId: "flight", status: "in_review" }),
      item("chat", { kind: "conversation", decision }),
      item("split", { parentId: "chat", status: "ready" }),
      item("closed", { status: "settled", decision }),
      item("archived", { archived: true, decision }),
    ]);
    expect(counts.get("a")).toEqual({ owner: 1, inflight: 2, open: 4 });
    expect(counts.get("p")).toEqual(counts.get("a"));
    expect(counts.get("sub")).toEqual({ owner: 1, inflight: 0, open: 1 });
    expect([...counts.keys()]).toEqual(["a", "p", "sub"]);
  });

  it("owner decisions override in flight, and all closed statuses are excluded", () => {
    const counts = treeCounts([
      ...containers(),
      item("owner", { status: "in_progress", decision }),
      ...(["settled", "abandoned", "superseded"] as const).map((status) => item(status, { status, decision })),
    ]);
    expect(counts.get("a")).toEqual({ owner: 1, inflight: 0, open: 1 });
  });

  it("returns zero for empty containers and disconnects archived branches", () => {
    expect(treeCounts(containers()).get("a")).toEqual({ owner: 0, inflight: 0, open: 0 });
    const counts = treeCounts([...containers(), item("hidden", { kind: "project", archived: true }), item("child", { parentId: "hidden", decision })]);
    expect(counts.has("hidden")).toBe(false);
    expect(counts.get("a")?.open).toBe(0);
    expect(treeCounts([]).size).toBe(0);
  });

  it("handles unordered deep trees and malformed cyclic/orphaned branches", () => {
    const chain = Array.from({ length: 1500 }, (_, n) => item(`p${n}`, { kind: "project", parentId: n ? `p${n - 1}` : null }));
    expect(treeCounts([item("leaf", { parentId: "p1499", status: "reopened" }), ...chain.reverse()]).get("p0")).toEqual({ owner: 0, inflight: 1, open: 1 });
    expect(
      treeCounts([item("x", { kind: "project", parentId: "y" }), item("y", { kind: "project", parentId: "x" }), item("orphan", { parentId: "missing" })]).size,
    ).toBe(2);
  });
});

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((q) => q.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(element: React.ReactElement, items: WorkItem[], decisions: DecisionsResponse = { entries: [], count: 0 }) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData<MapResponse>(MAP_KEY, { items, links: {}, decisions });
  return render(React.createElement(QueryClientProvider, { client }, element));
}

describe("Board and tree status rendering", () => {
  const work = () => [
    ...containers(),
    item("sub", { kind: "project" }),
    item("leaf", { parentId: "sub", status: "in_progress" }),
    item("sibling", { status: "ready" }),
    item("other-area", { parentId: null, kind: "area" }),
    item("other", { parentId: "other-area" }),
  ];

  it("preserves all-area selectors, collapsed projects, filters and empty/reset behaviour", () => {
    const view = mount(React.createElement(BoardTab, { scopeId: null }), work());
    expect(view.getByLabelText("Filter by area")).toBeTruthy();
    expect(view.getByTestId("map-tree").querySelectorAll("details.mp-area")).toHaveLength(2);
    expect(view.container.querySelector("details.mp-proj")?.hasAttribute("open")).toBe(false);
    fireEvent.change(view.getByLabelText("Search the map"), { target: { value: "leaf" } });
    expect(view.getAllByTestId("map-row")).toHaveLength(1);
    expect(view.container.querySelector("details.mp-proj")?.hasAttribute("open")).toBe(true);
    fireEvent.change(view.getByLabelText("Search the map"), { target: { value: "no match" } });
    expect(view.getByTestId("map-empty").textContent).toBe("Nothing matches these filters.");
    fireEvent.click(view.getByText("Reset"));
    expect(view.getAllByTestId("map-row")).toHaveLength(3);
  });

  it.each(["a", "p", "sub", "leaf"])("scopes %s, opens groups and retains real item hrefs", (scopeId) => {
    const onOpen = vi.fn();
    const view = mount(React.createElement(BoardTab, { scopeId, selectedId: "leaf", onOpen }), work());
    expect(view.queryByLabelText("Filter by area")).toBeNull();
    expect(view.queryByText("other")).toBeNull();
    expect([...view.container.querySelectorAll("details")].every((d) => d.open)).toBe(true);
    const title = view.getByRole("link", { name: "leaf" });
    expect(title.getAttribute("href")).toBe("/areas?item=leaf");
    expect(title.closest("li")?.getAttribute("data-selected")).toBe("true");
    // Mounting already selected (a tab switch) keeps the page still; only a later selection scrolls.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledWith("leaf");
    // Preserve native modified-click semantics without asking jsdom to navigate.
    title.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(title, { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    if (scopeId === "leaf" || scopeId === "sub") expect(view.queryByText("sibling")).toBeNull();
  });

  it.each(["a", "p"])("renders a nested area under %s as a scoped branch, including filters and reset", (parentId) => {
    const items = [...work(), item("nested-area", { parentId, kind: "area" }), item("nested-leaf", { parentId: "nested-area" })];
    const view = mount(React.createElement(BoardTab, { scopeId: "nested-area" }), items);
    expect(view.queryByTestId("map-empty")).toBeNull();
    expect(view.getByRole("link", { name: "nested-leaf" })).toBeTruthy();
    expect(view.queryByRole("link", { name: "sibling" })).toBeNull();
    fireEvent.change(view.getByLabelText("Search the map"), { target: { value: "missing" } });
    expect(view.getByTestId("map-empty")).toBeTruthy();
    fireEvent.click(view.getByText("Reset"));
    expect(view.getByRole("link", { name: "nested-leaf" })).toBeTruthy();
  });

  it("does not render the drill-down on Overview and renders both digest sections", () => {
    const view = mount(React.createElement(MapView), work());
    expect(view.queryByTestId("map-tree")).toBeNull();
    expect(view.queryByLabelText("Search the map")).toBeNull();
    expect(view.getByTestId("digest-inflight").textContent).toContain("leaf");
    expect(view.getByTestId("digest-outstanding").textContent).toContain("sibling");
    expect(view.getByTestId("map-overview")).toBeTruthy();
  });

  it.each([true, false])("limits Needs you by phone viewport (%s), not pane width", (phone) => {
    vi.stubGlobal("matchMedia", () => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const entries: DecisionsResponse["entries"] = Array.from({ length: 6 }, (_, n) => ({
      key: `approval:${n}`,
      kind: "approval",
      title: `Approval ${n}`,
      question: "Approve?",
      choices: [],
      href: "/decisions",
      at: "2026-11-06",
    }));
    const view = mount(React.createElement(MapView), work(), { entries, count: entries.length });
    expect(view.getAllByTestId("decision-row")).toHaveLength(phone ? 3 : 5);
  });

  it("links capped digests to Board and opens a digest item in place", () => {
    const onOpen = vi.fn();
    const items = [...containers(), ...Array.from({ length: 7 }, (_, n) => item(`flight${n}`, { status: "in_progress" }))];
    const view = mount(React.createElement<{ onOpen?: (id: string) => void }>(MapView, { onOpen }), items);
    const section = within(view.getByTestId("digest-inflight"));
    expect(section.getByRole("link", { name: "Show all 7" }).getAttribute("href")).toBe("/areas?tab=board");
    expect(section.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(section.getByRole("link", { name: /flight0/ }));
    expect(onOpen).toHaveBeenCalledWith("flight0");
  });

  it("keeps inline next-action edits optimistic and shows the shared UndoBar", async () => {
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ op: { id: "edit-1", kind: "edit", label: "Saved" } });
    const undo = vi.spyOn(api, "post").mockResolvedValue({ itemId: "leaf", item: null, outcome: "undone" });
    const view = mount(React.createElement(BoardTab, { scopeId: "sub" }), work());
    fireEvent.click(view.getByRole("button", { name: "Next: Next step" }));
    const input = view.getByLabelText("Edit next action");
    fireEvent.change(input, { target: { value: "Verify the board" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/work/items/leaf", { nextAction: "Verify the board" }));
    expect(await view.findByText("Next: Verify the board")).toBeTruthy();
    const bar = await view.findByRole("status");
    expect(bar.textContent).toContain("Saved");
    fireEvent.click(within(bar).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("/api/work/ops/edit-1/undo"));
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  });

  it("keeps default tree rows unchanged and adds counts, dots and next text only when opted in", () => {
    const items = [...containers(), item("owner", { decision }), item("flight", { status: "in_progress" }), item("closed", { status: "settled" })];
    const props = { items, selected: null, onSelect: vi.fn() };
    const view = render(React.createElement(WorkTree, props));
    expect(view.container.querySelector(".wk-tree-next, .wk-tree-agent, .wk-tree-count")).toBeNull();
    expect(view.getByRole("treeitem", { name: "Area, area" })).toBeTruthy();
    view.rerender(React.createElement(WorkTree, { ...props, status: { runs: { flight: "running", owner: "waiting", closed: "done" }, showNext: true } }));
    expect(view.getByRole("treeitem", { name: "Area, area, 1 need you, 1 in flight" })).toBeTruthy();
    expect(view.container.querySelectorAll(".wk-tree-next")).toHaveLength(2);
    expect(view.container.querySelectorAll(".wk-tree-agent")).toHaveLength(2);
    expect(view.container.querySelector(".wk-tree-agent[data-live='running']")).toBeTruthy();
    fireEvent.click(view.getByRole("treeitem", { name: "Project, project, Captured, 1 need you" }).querySelector("[aria-hidden='true']")!);
    expect(view.container.querySelectorAll(".wk-tree-next")).toHaveLength(0);
  });
});
