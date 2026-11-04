// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { CoordinatorThread, type CoordinatorResponse } from "@/components/coordinator/CoordinatorThread";
import { GlobalCoordinator } from "@/components/coordinator/GlobalCoordinator";
import { useCoordinatorThings, useStableLine } from "@/components/coordinator/useCoordinatorThings";
import { priorityLine } from "@/lib/coordinator/things";
import type { ActivityItem } from "@/lib/activity";
import type { ItemAgentInfo } from "@/lib/agent-runs";

const nav = vi.hoisted(() => ({ path: "/areas", search: "", wide: true }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
}));
const clients: QueryClient[] = [];
let info: CoordinatorResponse | { area: null };
let activity: ActivityItem[];
let runs: Record<string, ItemAgentInfo>;
let workItems: Record<string, unknown>[];
const base: CoordinatorResponse = {
  area: { id: "portfolio", title: "Portfolio" },
  agent: { requested: "chiefofstaff", profile: null, routed: false, reason: "routing_off" },
  sessionId: null,
  sessionTitle: null,
  excluded: false,
  prompt: "Catch me up",
  lastRunAt: null,
};
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={clients.at(-1)!}>{children}</QueryClientProvider>;
}
function makeClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(qc);
  return qc;
}
const globalView = () => (
  <div className="jv-shell">
    <GlobalCoordinator />
  </div>
);
const action = (id: string, via: string, at = new Date().toISOString()): ActivityItem => ({
  id,
  at,
  type: "created",
  actor: { kind: "agent", name: "chiefofstaff" },
  verb: "created",
  object: { id, title: `Item ${id}` },
  detail: null,
  via,
  undoOpId: `op-${id}`,
});

beforeEach(() => {
  nav.path = "/areas";
  nav.search = "";
  nav.wide = true;
  localStorage.clear();
  info = { ...base };
  activity = [];
  runs = {};
  workItems = [];
  vi.stubGlobal("matchMedia", () => ({ matches: nav.wide, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  // jsdom has no dialog top layer. Model only open/close; the browser spec covers real focus trapping.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    }),
  });
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path === "/api/work/coordinator/global") return info;
    if (path === "/api/work/decisions") return { entries: [], count: 0 };
    if (path === "/api/work/agent-runs") return { items: runs, active: [] };
    if (path.startsWith("/api/work/activity")) return { items: activity, nextCursor: null, latestAt: activity[0]?.at ?? null };
    if (path === "/api/work/items") return { items: workItems };
    if (path.startsWith("/api/hermes/sessions/"))
      return {
        session: { id: "s1", pinned: false, archived: false },
        timeline: [{ kind: "user", id: "u1", text: "Hello", at: new Date(Date.now() - 5000).toISOString() }],
      };
    throw new Error(`Unexpected API path: ${path}`);
  });
  vi.spyOn(api, "post").mockImplementation(async (path) =>
    path === "/api/hermes/sessions" ? { id: "s1", title: "Portfolio coordinator", pinned: false, archived: false } : { ok: true },
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((qc) => qc.clear());
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared coordinator thread", () => {
  it("never sends on fill or Enter; Ctrl+Enter creates a session and sends with one context line", async () => {
    makeClient();
    render(<CoordinatorThread info={base} compact context={{ label: "Areas › Garage", path: "/areas?item=garage" }} />, { wrapper });
    const input = screen.getByRole("textbox", { name: "Message the coordinator" });
    fireEvent.change(input, { target: { value: "Please help\nwith this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/hermes/sessions/s1/runs",
        expect.objectContaining({ input: "[Viewing: Areas › Garage — /areas?item=garage]\nPlease help\nwith this" }),
      ),
    );
    expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions", { title: "Portfolio coordinator", areaId: "portfolio" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });
  it("retains area pane testids and catch-up behavior without sending page context", async () => {
    makeClient();
    render(<CoordinatorThread info={base} />, { wrapper });
    expect(screen.getByTestId("coordinator-body")).toBeTruthy();
    expect(screen.getByTestId("coordinator-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("coordinator-catch-up"));
    expect((screen.getByTestId("coordinator-input") as HTMLTextAreaElement).value).toBe("Catch me up");
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("coordinator-send"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/s1/runs", expect.objectContaining({ input: "Catch me up" })));
  });
  it("does not fetch a thread or show a composer for excluded areas", () => {
    makeClient();
    render(<CoordinatorThread info={{ ...base, excluded: true, sessionId: "finance-session" }} />, { wrapper });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("coordinator-excluded")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("quick action slots fill the composer, never send", () => {
    makeClient();
    render(
      <CoordinatorThread
        info={{ ...base, sessionId: "s1" }}
        compact
        quickActions={(onPrompt) => (
          <button type="button" onClick={() => onPrompt("Review this")}>
            Review
          </button>
        )}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect((screen.getByTestId("gc-input") as HTMLTextAreaElement).value).toBe("Review this");
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("global coordinator", () => {
  it("removes context until navigation, and This page only fills the draft", async () => {
    makeClient();
    const view = render(globalView(), { wrapper });
    await screen.findByTestId("gc-input");
    const chatPanel = () => within(screen.getByRole("tabpanel", { name: "Chat" }));
    expect(chatPanel().getByText("Viewing: Areas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove page context" }));
    expect(chatPanel().queryByText("Viewing: Areas")).toBeNull();
    nav.path = "/decisions";
    view.rerender(globalView());
    await chatPanel().findByText("Viewing: Needs you");
    fireEvent.click(screen.getByRole("tab", { name: "This page" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this page" }));
    expect((screen.getByTestId("gc-input") as HTMLTextAreaElement).value).toContain("Help me understand this page");
    expect(api.post).not.toHaveBeenCalled();
    nav.path = "/areas";
    view.rerender(globalView());
    await chatPanel().findByText("Viewing: Areas");
  });
  it("never displays or attaches Finance page context", async () => {
    nav.path = "/finance/cards";
    makeClient();
    render(globalView(), { wrapper });
    const input = await screen.findByTestId("gc-input");
    expect(document.querySelector(".gc-context")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "This page" }));
    expect(screen.getByText("No page context is shared.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask about this page" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/s1/runs", expect.objectContaining({ input: "Hello" })));
  });
  it("persists rail open state and clamps keyboard resizing; chat starts as a strip", async () => {
    makeClient();
    localStorage.setItem("jarvis.gc.width", "900");
    const view = render(globalView(), { wrapper });
    await screen.findByTestId("gc-input");
    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("aria-valuenow")).toBe("520");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(localStorage.getItem("jarvis.gc.width")).toBe("500");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Chief of staff" }));
    expect(localStorage.getItem("jarvis.gc.open")).toBe("false");
    nav.path = "/decisions";
    view.rerender(globalView());
    expect(screen.getByTestId("gc-rail").getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand Chief of staff" }));
    expect(localStorage.getItem("jarvis.gc.open")).toBe("true");
    nav.path = "/chat/s1";
    view.rerender(globalView());
    expect(screen.getByTestId("gc-rail").style.width).toBe("54px");
    fireEvent.click(screen.getByRole("button", { name: "Expand Chief of staff" }));
    expect(screen.getByTestId("gc-rail").style.width).toBe("500px");
    expect(document.querySelector<HTMLElement>(".jv-shell")?.style.getPropertyValue("--gc-w")).toBe("500px");
  });
  it.each(["/areas?item=private", "/areas?node=private", "/chat/private-session"])("omits page context for Finance ancestry on %s", async (path) => {
    const url = new URL(path, "http://localhost");
    nav.path = url.pathname;
    nav.search = url.search;
    workItems = [
      { id: "finance", parentId: null, kind: "area", title: "Finance", settings: null },
      { id: "private", parentId: "finance", kind: "conversation", title: "Private", sessionId: "private-session", settings: null },
    ];
    makeClient();
    render(globalView(), { wrapper });
    if (path.startsWith("/chat/")) fireEvent.click(screen.getByRole("button", { name: "Expand Chief of staff" }));
    await screen.findByTestId("gc-input");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/work/items"));
    expect(document.querySelector(".gc-context")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "This page" }));
    expect(screen.getByText("No page context is shared.")).toBeTruthy();
  });
  it("opens the phone modal from its tray and restores focus when closed; hides tray on chat", async () => {
    nav.wide = false;
    makeClient();
    const view = render(globalView(), { wrapper });
    const tray = screen.getByRole("button", { name: "Chief of staff" });
    tray.focus();
    fireEvent.click(tray);
    const sheet = screen.getByRole("dialog", { name: "Chief of staff" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close Chief of staff" }));
    expect(document.activeElement).toBe(tray);
    nav.path = "/chat/s1";
    view.rerender(globalView());
    expect(screen.queryByRole("button", { name: "Chief of staff" })).toBeNull();
  });
  it("renders the no-area setup link without a send control", async () => {
    info = { area: null };
    makeClient();
    render(globalView(), { wrapper });
    expect(await screen.findByText(/No Chief of staff yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings → Agents" }).getAttribute("href")).toBe("/settings/agents");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("shows recent attributed action cards inline and in Changes, and calls the existing undo endpoint", async () => {
    info = { ...base, sessionId: "s1" };
    activity = [action("new", "chiefofstaff"), action("old", "chiefofstaff", new Date(Date.now() - 10000).toISOString()), action("other", "devchief")];
    makeClient();
    render(globalView(), { wrapper });
    const chatPanel = screen.getByRole("tabpanel", { name: "Chat" });
    await waitFor(() => expect(within(chatPanel).getByRole("link", { name: "Item new" })).toBeTruthy());
    expect(within(chatPanel).queryByRole("link", { name: "Item old" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Changes/ }));
    const changes = screen.getByRole("tabpanel", { name: /Changes/ });
    expect(within(changes).getByRole("link", { name: "Item old" })).toBeTruthy();
    expect(within(changes).queryByRole("link", { name: "Item other" })).toBeNull();
    fireEvent.click(within(changes).getByRole("button", { name: "Undo Created item: Item new" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/work/ops/op-new/undo"));
  });
});

it("polls local endpoints and filters raw/normalized attribution and the 24h window", async () => {
  activity = [
    action("bare", "chiefofstaff"),
    action("raw", "agent:chiefofstaff"),
    action("other", "devchief"),
    action("old", "chiefofstaff", new Date(Date.now() - 86_400_001).toISOString()),
  ];
  makeClient();
  const { result } = renderHook(() => useCoordinatorThings(), { wrapper });
  await waitFor(() => expect(result.current.things.changes.map((a) => a.id)).toEqual(["bare", "raw"]));
  expect(api.get).toHaveBeenCalledWith("/api/work/decisions");
  expect(api.get).toHaveBeenCalledWith("/api/work/agent-runs");
  expect(api.get).toHaveBeenCalledWith("/api/work/activity?actor=agent&q=chiefofstaff&limit=200");
  expect(api.post).not.toHaveBeenCalled();
});

it("keeps mixed Hermes/delegation states, flags stalled runs, and remembers PR-only merges as seen", async () => {
  const at = new Date().toISOString();
  const item = (id: string, extra: Partial<ItemAgentInfo> = {}): ItemAgentInfo => ({
    itemId: id,
    areaId: "portfolio",
    title: id,
    who: null,
    live: "idle",
    liveAt: null,
    sessionId: null,
    runs: 0,
    prs: [],
    report: null,
    progress: null,
    ...extra,
  });
  runs = {
    mixed: item("mixed", {
      live: "running",
      liveAt: at,
      agentRuns: [{ id: "delegation", profile: "devchief", title: "Done delegation", state: "done", startedAt: at, updatedAt: at, summary: null, prUrl: null }],
    }),
    stalled: item("stalled", {
      live: "running",
      agentRuns: [
        {
          id: "stalled-run",
          profile: "devchief",
          title: "No heartbeat",
          state: "running",
          startedAt: at,
          updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
          summary: null,
          prUrl: null,
        },
      ],
    }),
    failed: item("failed", { live: "failed", liveAt: at }),
    merged: item("merged", {
      prs: [{ ref: "o/r#1", url: "https://github.com/o/r/pull/1", title: "Merged", state: "merged", checks: "success", deploy: "waiting" }],
    }),
  };
  makeClient();
  const { result } = renderHook(() => useCoordinatorThings(), { wrapper });
  await waitFor(() => expect(result.current.things.failing).toHaveLength(2));
  expect(result.current.things.running.map((r) => r.id)).toContain("mixed");
  expect(result.current.things.failing.map((r) => r.state)).toEqual(["stalled", "failed"]);
  expect(result.current.things.doneUnseen).toBe(2);
  expect(result.current.line.state).toBe("failing");
  act(() => result.current.markSeen());
  expect(result.current.things.doneUnseen).toBe(0);
  expect(JSON.parse(localStorage.getItem("jarvis.gc.mergedSeen")!)).toEqual(["merged:o/r#1"]);
});

it("bounds downward hysteresis even if the lower-priority counts keep changing; upward is immediate", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const high = priorityLine({ failing: 1, needsYou: 0, doneUnseen: 0, running: 0 });
  const low = priorityLine({ failing: 0, needsYou: 0, doneUnseen: 0, running: 1 });
  const { result, rerender } = renderHook((line) => useStableLine(line), { initialProps: high });
  rerender(low);
  act(() => vi.advanceTimersByTime(3000));
  rerender({ ...low, count: 2, text: "2 runs in progress" });
  act(() => vi.advanceTimersByTime(999));
  expect(result.current.state).toBe("failing");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toMatchObject({ state: "running", count: 2 });
  rerender(high);
  expect(result.current.state).toBe("failing");
});
