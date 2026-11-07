// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { radialLayout, wrapLabel, type RadialNodeIn, type RadialRelation } from "@/lib/radial-layout";
import type { WorkItem } from "@/lib/work";

const node = (id: string, parentId: string | null = "root", title = id): RadialNodeIn => ({
  id,
  parentId,
  title,
  kind: parentId === null ? "area" : "thread",
  status: "ready",
});
const root = node("root", null, "Development");
const opts = { width: 400, height: 400 };
const tree = [root, ...Array.from({ length: 4 }, (_, i) => node(`child-${i}`)), ...Array.from({ length: 3 }, (_, i) => node(`grandchild-${i}`, "child-0"))];

describe("radialLayout", () => {
  it("centres the selected node and uses size-proportional radii", () => {
    const layout = radialLayout("root", tree, [], { width: 800, height: 600 });
    expect(layout.nodes[0]).toMatchObject({ id: "root", ring: 0, x: 400, y: 300, anchor: "middle" });
    expect(layout.radius.r1).toBeCloseTo(600 * 0.27);
    expect(layout.radius.r2).toBeCloseTo(600 * 0.44);
  });

  it("spaces ring 1 evenly, clockwise, starting at the top", () => {
    const layout = radialLayout("root", tree, [], opts);
    const ring = layout.nodes.filter((n) => n.ring === 1);
    expect(ring.map((n) => n.id)).toEqual(["child-0", "child-1", "child-2", "child-3"]);
    ring.forEach((n, i) => {
      expect(Math.hypot(n.x - 200, n.y - 200)).toBeCloseTo(layout.radius.r1);
      expect(n.angle).toBeCloseTo(-Math.PI / 2 + (i * Math.PI) / 2);
    });
    expect(ring[0].x).toBeCloseTo(200);
    expect(ring[0].y).toBeCloseTo(200 - layout.radius.r1);
    expect(ring.map((n) => n.anchor)).toEqual(["middle", "start", "middle", "end"]);
  });

  it("keeps grandchildren at r2 inside their parent's non-overlapping wedge", () => {
    const dense = [...tree, ...Array.from({ length: 6 }, (_, i) => node(`other-${i}`, "child-1"))];
    const layout = radialLayout("root", dense, [], opts);
    for (const n of layout.nodes.filter((n) => n.ring === 2)) {
      const parent = layout.nodes.find((p) => p.id === n.parentId)!;
      expect(Math.abs(n.angle - parent.angle)).toBeLessThan(Math.PI / 4);
      expect(Math.hypot(n.x - 200, n.y - 200)).toBeCloseTo(layout.radius.r2);
      expect(layout.edges).toContainEqual({ from: parent.id, to: n.id, kind: "contains", path: `M ${parent.x} ${parent.y} L ${n.x} ${n.y}` });
    }
  });

  it("collapses dense outer wedges instead of overlapping their dots", () => {
    const layout = radialLayout(
      "root",
      [root, ...Array.from({ length: 12 }, (_, i) => node(`c${i}`)), ...Array.from({ length: 100 }, (_, i) => node(`g${i}`, "c0"))],
      [],
      opts,
    );
    const grandchildren = layout.nodes.filter((n) => n.ring === 2);
    expect(layout.nodes.find((n) => n.id === "c0")!.more + grandchildren.length).toBe(100);
    for (let i = 1; i < grandchildren.length; i++)
      expect(Math.hypot(grandchildren[i].x - grandchildren[i - 1].x, grandchildren[i].y - grandchildren[i - 1].y)).toBeGreaterThanOrEqual(23.99);
  });

  it("replaces excess ring-1 nodes with a +N more node", () => {
    const layout = radialLayout("root", [root, ...Array.from({ length: 15 }, (_, i) => node(`c${i}`))], [], opts);
    const ring = layout.nodes.filter((n) => n.ring === 1);
    expect(ring).toHaveLength(12);
    expect(ring[11]).toMatchObject({ id: "__more:root", title: "+4 more", parentId: "root" });
    expect(radialLayout("root", tree, [], { ...opts, maxPerRing: 2 }).nodes.find((n) => n.id === "__more:root")?.title).toBe("+3 more");
  });

  it("uses one ring, hidden-child counts and the smaller cap in compact mode", () => {
    const layout = radialLayout("root", tree, [], { ...opts, compact: true });
    expect(layout.nodes.some((n) => n.ring === 2)).toBe(false);
    expect(layout.nodes.find((n) => n.id === "child-0")?.more).toBe(3);
    expect(layout.radius.r1).toBeCloseTo(136);
    const many = radialLayout("root", [root, ...Array.from({ length: 10 }, (_, i) => node(`c${i}`))], [], { ...opts, compact: true });
    expect(many.nodes.filter((n) => n.ring === 1)).toHaveLength(8);
    expect(many.nodes.find((n) => n.id === "__more:root")?.title).toBe("+3 more");
  });

  it("adds at most six ghosts, in both relation directions, without ghost expansion", () => {
    const outside = Array.from({ length: 10 }, (_, i) => node(`outside-${i}`, "elsewhere"));
    const relations: RadialRelation[] = outside.map((n, i) =>
      i % 2 ? { from: n.id, to: "child-0", kind: "followup" } : { from: "child-0", to: n.id, kind: "depends" },
    );
    relations.push({ from: "outside-0", to: "outside-9", kind: "depends" });
    const layout = radialLayout("root", [...tree, ...outside], relations, opts);
    const ghosts = layout.nodes.filter((n) => n.ghost);
    expect(ghosts).toHaveLength(6);
    for (const ghost of ghosts) {
      expect(ghost.ring).toBe(3);
      expect(ghost.angle).toBe(layout.nodes.find((n) => n.id === "child-0")?.angle);
    }
    expect(layout.edges.filter((e) => e.kind !== "contains")).toHaveLength(6);
    expect(layout.edges.filter((e) => e.kind !== "contains").every((e) => e.path.includes(" Q "))).toBe(true);
  });

  it("deduplicates ghosts, tolerates partial snapshots and ignores unconnected endpoints", () => {
    const relations: RadialRelation[] = [
      { from: "child-0", to: "outside", kind: "depends" },
      { from: "child-1", to: "outside", kind: "followup" },
      { from: "root", to: "missing", kind: "depends" },
      { from: "unplaced", to: "outside", kind: "depends" },
    ];
    const layout = radialLayout("root", [...tree, node("outside", "elsewhere")], relations, opts);
    expect(layout.nodes.filter((n) => n.ghost)).toHaveLength(2);
    expect(layout.nodes.find((n) => n.id === "missing")).toMatchObject({ title: "missing", ghost: true });
    expect(layout.edges.filter((e) => e.kind !== "contains")).toHaveLength(3);
  });

  it("draws links between placed ghosts without recursively expanding them", () => {
    const relations: RadialRelation[] = [
      { from: "outside-a", to: "outside-b", kind: "followup" },
      { from: "outside-b", to: "unconnected", kind: "depends" },
      { from: "root", to: "outside-a", kind: "depends" },
      { from: "child-0", to: "outside-b", kind: "depends" },
    ];
    const layout = radialLayout("root", tree, relations, opts);
    expect(layout.nodes.filter((n) => n.ghost)).toHaveLength(2);
    expect(layout.edges.filter((edge) => edge.kind !== "contains")).toHaveLength(3);
    expect(layout.edges.some((edge) => edge.kind === "followup" && edge.from === "outside-a" && edge.to === "outside-b")).toBe(true);
  });

  it("curves placed-to-placed relations away from the centre", () => {
    const layout = radialLayout("root", tree, [{ from: "child-0", to: "child-1", kind: "depends" }], opts);
    const edge = layout.edges.find((e) => e.kind === "depends")!;
    const parts = edge.path.split(" ");
    const control = { x: Number(parts[4]), y: Number(parts[5]) };
    expect(control.x).toBeGreaterThan(254);
    expect(control.y).toBeLessThan(146);
    expect(layout.nodes.some((n) => n.ghost)).toBe(false);
  });

  it("uses a virtual All areas centre with top-level areas only", () => {
    const layout = radialLayout(null, [node("home", null), root, node("project", "root"), { ...node("orphan", null), kind: "thread" }], [], opts);
    expect(layout.nodes[0]).toMatchObject({ id: "__all", title: "All areas", ring: 0 });
    expect(layout.nodes.filter((n) => n.ring === 1).map((n) => n.id)).toEqual(["home", "root"]);
    expect(layout.nodes.find((n) => n.id === "project")?.ring).toBe(2);
  });

  it("keeps twelve radius-10 ring-1 nodes separated at 400 by 400", () => {
    const ring = radialLayout("root", [root, ...Array.from({ length: 12 }, (_, i) => node(`c${i}`))], [], opts).nodes.filter((n) => n.ring === 1);
    for (let i = 0; i < ring.length; i++)
      for (let j = i + 1; j < ring.length; j++) expect(Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y)).toBeGreaterThan(20);
  });

  it("is deterministic, does not mutate inputs and tolerates missing/empty centres", () => {
    const before = JSON.stringify(tree);
    expect(radialLayout("root", tree, [], opts)).toEqual(radialLayout("root", tree, [], opts));
    expect(JSON.stringify(tree)).toBe(before);
    expect(radialLayout("missing", tree, [], opts).nodes).toEqual([]);
    expect(radialLayout(null, [], [], opts).nodes).toHaveLength(1);
    expect(radialLayout("root", [root], [], opts).nodes).toHaveLength(1);
  });
});

describe("wrapLabel", () => {
  it("wraps at word boundaries without truncating words", () => {
    expect(wrapLabel("  Alpha   beta gamma delta  ", 10)).toEqual(["Alpha beta", "gamma", "delta"]);
    expect(wrapLabel("short", 16)).toEqual(["short"]);
    expect(wrapLabel("", 16)).toEqual([]);
  });
  it("only hard-breaks words longer than the line", () => {
    expect(wrapLabel("abcdefghijklmnop", 6)).toEqual(["abcdef", "ghijkl", "mnop"]);
    expect(wrapLabel("hello abcdefghij", 6)).toEqual(["hello", "abcdef", "ghij"]);
  });
  it("caps at three lines and adds an ellipsis only when text remains", () => {
    expect(wrapLabel("one two six ten", 3)).toEqual(["one", "two", "six…"]);
    expect(wrapLabel("one two six", 3)).toEqual(["one", "two", "six"]);
    expect(wrapLabel("abcdefghijklmnop", 4)).toEqual(["abcd", "efgh", "ijkl…"]);
    expect(wrapLabel("abc", 0)).toEqual(["a", "b", "c"]);
  });
});

const mocks = vi.hoisted(() => ({
  overview: { relations: {} } as { relations?: Record<string, { kind: "depends" | "followup"; id: string; title: string; open: boolean }[]> },
  runs: { items: {} } as { items: Record<string, { live: string }> },
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: mocks.overview }) }));
vi.mock("@/components/map/MapView", () => ({ MAP_KEY: ["work", "overview"] }));
vi.mock("@/components/agents/AgentRuns", () => ({ useAgentRuns: () => ({ data: mocks.runs }) }));
vi.mock("@/components/work/WorkMap", () => ({ STATUS_VAR: { captured: "var(--line-strong)", ready: "var(--accent)", settled: "var(--ok)" } }));
import { GraphTab } from "@/components/areas/GraphTab";

const work = (n: RadialNodeIn, extra: Partial<WorkItem> = {}): WorkItem => ({
  ...n,
  summary: "",
  nextAction: "Run the checks",
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
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});
let rootWidth = 800;
let stageWidth = 800;
beforeEach(() => {
  rootWidth = stageWidth = 800;
  mocks.overview = {};
  mocks.runs = { items: {} };
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: target.tagName === "SECTION" ? rootWidth : stageWidth, height: 480 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const setup = (items = tree.map((n) => work(n)), centreId: string | null = "root") => {
  const onRecentre = vi.fn();
  const onOpen = vi.fn();
  const result = render(createElement(GraphTab, { items, centreId, onRecentre, onOpen }));
  return { ...result, onRecentre, onOpen };
};

describe("GraphTab", () => {
  it("renders the graph, breadcrumbs and centre card with keyboard navigation", () => {
    const { onRecentre, onOpen } = setup();
    expect(screen.getByTestId("radial-graph").getAttribute("aria-label")).toBe("Graph of Development");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Graph breadcrumb" })).getByRole("button", { name: "All areas" }));
    expect(onRecentre).toHaveBeenLastCalledWith(null);
    const centre = screen.getByTestId("radial-graph").querySelector('[data-centre="true"]')!;
    fireEvent.keyDown(centre, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("root");
    fireEvent.keyDown(screen.getByTestId("radial-graph").querySelector('[data-node-id="child-0"]')!, { key: " " });
    expect(onRecentre).toHaveBeenLastCalledWith("child-0");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenLastCalledWith("root");
    expect(screen.getByText("Run the checks")).toBeTruthy();
  });

  it("reparents work through hidden ancestors without hiding Finance", () => {
    const { container } = setup([
      work(root),
      work(node("conversation"), { kind: "conversation" }),
      work(node("archive", "conversation"), { archived: true }),
      work(node("kept", "archive")),
      work(node("finance", null, "Finance")),
    ]);
    expect(container.querySelector('[data-node-id="kept"][data-ring="1"]')).toBeTruthy();
    expect(container.querySelector('[data-node-id="conversation"]')).toBeNull();
    expect(container.querySelector('[data-node-id="archive"]')).toBeNull();
    cleanup();
    setup([work(node("finance", null, "Finance"))], null);
    expect(screen.getByTestId("radial-graph").querySelector('[data-node-id="finance"]')).toBeTruthy();
  });

  it("makes the full list available from overflow, including hidden grandchildren and relation links", () => {
    mocks.overview = { relations: { "child-0": [{ kind: "depends", id: "outside", title: "External dependency", open: true }] } };
    const { onRecentre } = setup([work(root), ...Array.from({ length: 15 }, (_, i) => work(node(`child-${i}`))), work(node("grandchild", "child-14"))]);
    fireEvent.click(screen.getByTestId("radial-graph").querySelector('[data-node-id="__more:root"]')!);
    expect(screen.getByRole("button", { name: "Show as list" }).getAttribute("aria-pressed")).toBe("true");
    const list = screen.getByRole("list", { name: "List of Development" });
    expect(within(list).getByRole("button", { name: "grandchild Ready" })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "External dependency" }));
    expect(onRecentre).toHaveBeenLastCalledWith("outside");
    fireEvent.click(screen.getByRole("button", { name: "Show as list" }));
    expect(screen.queryByRole("list", { name: "List of Development" })).toBeNull();
  });

  it("auto-selects the list below 300px and collapses grandchildren below 560px", () => {
    rootWidth = stageWidth = 280;
    setup();
    expect(screen.getByRole("list", { name: "List of Development" })).toBeTruthy();
    cleanup();
    rootWidth = stageWidth = 400;
    setup();
    expect(screen.getByTestId("radial-graph").querySelector('[data-ring="2"]')).toBeNull();
    expect(screen.getByRole("button", { name: "child-0, Ready, 3 more" })).toBeTruthy();
  });

  it("renders agent states, relation ghosts and empty centres with missing relation data", () => {
    mocks.overview = { relations: { root: [{ kind: "depends", id: "outside", title: "Outside work", open: true }] } };
    mocks.runs = { items: { root: { live: "running" }, outside: { live: "waiting" } } };
    const { onRecentre, container } = setup([work(root)]);
    expect(container.querySelector('.ar-graph-agent[data-live="running"]')).toBeTruthy();
    expect(container.querySelector('.ar-graph-agent[data-live="waiting"]')).toBeTruthy();
    fireEvent.click(container.querySelector('[data-node-id="outside"]')!);
    expect(onRecentre).toHaveBeenLastCalledWith("outside");
    cleanup();
    mocks.overview = {};
    setup([work(root)]);
    expect(screen.getByText("Nothing below Development yet.")).toBeTruthy();
    expect(screen.getByTestId("radial-graph").querySelector('[data-centre="true"]')).toBeTruthy();
  });

  it("zooms with controls and fits the graph", () => {
    const { container } = setup();
    const camera = () => container.querySelector('svg[data-testid="radial-graph"] > g')!.getAttribute("transform");
    expect(camera()).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(camera()).toContain("scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(camera()).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(camera()).not.toContain("NaN");
  });

  it("wheel-zooms around the pointer and clamps scale", () => {
    setup();
    const svg = screen.getByTestId("radial-graph");
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 480 } as DOMRect);
    const transform = () => svg.firstElementChild!.getAttribute("transform")!;
    fireEvent.wheel(svg, { clientX: 200, clientY: 120, deltaY: -100, ctrlKey: true });
    const values = transform()
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    expect(values[2]).toBeGreaterThan(1);
    expect((200 - values[0]) / values[2]).toBeCloseTo(200);
    expect((120 - values[1]) / values[2]).toBeCloseTo(120);
    for (let i = 0; i < 10; i++) fireEvent.wheel(svg, { clientX: 200, clientY: 120, deltaY: -100 });
    expect(transform()).toContain("scale(3)");
    for (let i = 0; i < 20; i++) fireEvent.wheel(svg, { clientX: 200, clientY: 120, deltaY: 100 });
    expect(transform()).toContain("scale(0.5)");
  });

  it("pans, pinches and never activates a node after a drag", () => {
    const { onRecentre } = setup();
    const svg = screen.getByTestId("radial-graph");
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 480 } as DOMRect);
    const child = svg.querySelector('[data-node-id="child-0"]')!;
    fireEvent.pointerDown(child, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(svg.firstElementChild!.getAttribute("transform")).toBe("translate(40 20) scale(1)");
    fireEvent.click(child, { detail: 1 });
    expect(onRecentre).not.toHaveBeenCalled();
    fireEvent.pointerDown(svg, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(svg, { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 300, clientY: 100 });
    expect(svg.firstElementChild!.getAttribute("transform")).toContain("scale(2)");
    fireEvent.pointerCancel(svg, { pointerId: 2 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    fireEvent.pointerDown(child, { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(child, { pointerId: 3 });
    fireEvent.click(child, { detail: 1 });
    expect(onRecentre).toHaveBeenLastCalledWith("child-0");
  });

  it("resets the camera and updates breadcrumbs when the owner recentres", () => {
    const { rerender, onRecentre, onOpen } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    rerender(createElement(GraphTab, { items: tree.map((n) => work(n)), centreId: "child-0", onRecentre, onOpen }));
    const svg = screen.getByTestId("radial-graph");
    expect(svg.firstElementChild!.getAttribute("transform")).toBe("translate(0 0) scale(1)");
    const breadcrumb = within(screen.getByRole("navigation", { name: "Graph breadcrumb" }));
    expect(breadcrumb.getAllByRole("button").map((button) => button.textContent)).toEqual(["All areas", "Development", "child-0"]);
    fireEvent.click(breadcrumb.getByRole("button", { name: "Development" }));
    expect(onRecentre).toHaveBeenLastCalledWith("root");
  });
});
