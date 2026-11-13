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
import { setPanelOwner } from "@/lib/client/panel-owner";
import type { DynamicCard } from "@/lib/jarvis-ui/dynamic";
import { COORDINATOR_PROMPT } from "@/lib/quick-actions";
import { OPEN_COORDINATOR_EVENT } from "@/components/navigation/commands";
import { ToastProvider } from "@/components/ui";

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
let quick: Record<string, unknown>[];
const qa = (id: string, label: string, prompt: string, pinned = false) => ({
  id,
  userId: "u",
  label,
  prompt,
  scope: "global",
  pinned,
  sortOrder: 0,
  status: "active",
  source: "owner",
  createdAt: "",
  updatedAt: "",
});
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
  quick = [];
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
    if (path === "/api/quick-actions") return { actions: quick };
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
  setPanelOwner(null);
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
  it("offline: says so, keeps the draft and never sends", () => {
    makeClient();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<CoordinatorThread info={{ ...base, sessionId: "s1" }} compact name="Chief of staff" />, { wrapper });
    const input = screen.getByTestId("gc-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Hello" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText(/You.re offline. Your draft is kept/)).toBeTruthy();
    expect(input.value).toBe("Hello");
  });
  it("shows the owner’s words in a bubble: page context becomes a caption and a decision receipt reads as the choice", async () => {
    makeClient();
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith("/api/hermes/sessions/s1/execution")) return { records: [], sources: [] };
      if (path.startsWith("/api/hermes/sessions/"))
        return {
          session: { id: "s1", pinned: false, archived: false },
          timeline: [
            { kind: "user", id: "u1", text: "[Viewing: Todos — /todos]\nSkip the weekly chores", at: new Date(Date.now() - 9000).toISOString() },
            { kind: "assistant", id: "a1", text: "Done.", at: new Date(Date.now() - 8000).toISOString() },
            {
              kind: "user",
              id: "u2",
              text: 'Decision on "Feature names": Decision: Use plain names? → Keep plain names',
              at: new Date(Date.now() - 7000).toISOString(),
            },
          ],
        };
      if (path === "/api/quick-actions") return { actions: [] };
      throw new Error(`Unexpected API path: ${path}`);
    });
    render(<CoordinatorThread info={{ ...base, sessionId: "s1" }} compact name="Chief of staff" />, { wrapper });
    expect(await screen.findByText("Skip the weekly chores")).toBeTruthy();
    expect(screen.queryByText(/\[Viewing:/)).toBeNull();
    expect(screen.getByText("Sent while viewing Todos")).toBeTruthy();
    expect(screen.getByText("You decided · Feature names")).toBeTruthy();
    expect(screen.getByText("Keep plain names")).toBeTruthy();
    // Replies are signed by who the owner is talking to, not by an internal role name.
    expect(screen.getByText("Chief of staff")).toBeTruthy();
    expect(screen.queryByText("Coordinator")).toBeNull();
  });
  it("has the full chat's add menu (photo or file, camera, context) and never uploads or sends by opening it", () => {
    makeClient();
    render(<CoordinatorThread info={{ ...base, sessionId: "s1" }} compact name="Chief of staff" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
    const menu = screen.getByRole("menu", { name: "Add to message" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Photo or file", "Camera", "Area, item or person"]);
    expect(document.querySelector('[data-testid="gc-file-input"]')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("the first attachment and a quick Send share one new conversation, and Send waits for the file", async () => {
    makeClient();
    // The new conversation never comes back in this test: everything asserted happens while it is being created.
    vi.mocked(api.post).mockImplementation(((path: string) =>
      path === "/api/hermes/sessions" ? new Promise(() => undefined) : Promise.resolve({ ok: true })) as typeof api.post);
    render(
      <ToastProvider>
        <CoordinatorThread info={base} compact name="Chief of staff" />
      </ToastProvider>,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
    const picker = document.querySelector('[data-testid="gc-file-input"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["a"], "plan.pdf", { type: "application/pdf" })] } });
    fireEvent.change(picker, { target: { files: [new File(["b"], "quote.pdf", { type: "application/pdf" })] } });
    const input = screen.getByRole("textbox", { name: "Message the coordinator" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Here is the plan" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    const posts = vi.mocked(api.post).mock.calls.map(([path]) => String(path));
    expect(posts.filter((path) => path === "/api/hermes/sessions")).toHaveLength(1);
    expect(posts.some((path) => path.endsWith("/runs"))).toBe(false);
    expect(input.value).toBe("Here is the plan");
    // Send was refused, and said why (without the guard it would start sending and say nothing)
    expect(screen.getByText("Wait for the upload to finish, then send.")).toBeTruthy();
  });
  it("renders smart (jarvis-ui) replies through the same renderer as full chat, never as raw JSON", async () => {
    makeClient();
    const reply =
      'Here is the plan.\n\n```jarvis-ui\n{"v":1,"catalog":"jarvis-ui@1","root":"r","elements":{"r":{"type":"Text","props":{"text":"Hidden spec"}}}}\n```\n';
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === "/api/smart/settings") return { enabled: false };
      if (path.startsWith("/api/hermes/sessions/s1/execution")) return { records: [], sources: [] };
      if (path.startsWith("/api/hermes/sessions/s1/files")) return { files: [] };
      if (path.startsWith("/api/hermes/sessions/"))
        return {
          session: { id: "s1", pinned: false, archived: false },
          timeline: [{ kind: "assistant", id: "a1", text: reply, at: new Date().toISOString() }],
        };
      if (path === "/api/quick-actions") return { actions: [] };
      throw new Error(`Unexpected API path: ${path}`);
    });
    render(<CoordinatorThread info={{ ...base, sessionId: "s1" }} compact name="Chief of staff" />, { wrapper });
    expect(await screen.findByText("Here is the plan.")).toBeTruthy();
    expect(screen.queryByText(/"catalog"/)).toBeNull();
    expect(await screen.findByText(/This reply has an interactive part/)).toBeTruthy();
  });
  it("quick action chips above the composer fill it, never send", async () => {
    makeClient();
    quick = [qa("q1", "Review", "Review {area}")];
    render(<CoordinatorThread info={{ ...base, sessionId: "s1" }} compact quickContext={{ areaId: "portfolio", areaTitle: "Portfolio" }} />, { wrapper });
    fireEvent.click(await within(screen.getByTestId("quick-actions-row")).findByRole("button", { name: "Review" }));
    expect((screen.getByTestId("gc-input") as HTMLTextAreaElement).value).toBe("Review Portfolio");
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("global coordinator", () => {
  it.each([true, false])("a palette prompt leaves an open dynamic card for visible chat and a filled draft (wide=%s)", async (wide) => {
    const qc = makeClient();
    nav.wide = wide;
    const card: DynamicCard = {
      id: "weekly-review:test",
      kind: "weekly-review",
      action: "Fill in",
      line: { tone: "warn", dot: "yellow", icon: "≡", label: "Weekly review", text: "Review this week" },
      sessionId: "dynamic:weekly-review:test",
      blockIndex: 0,
      spec: { v: 1, catalog: "jarvis-ui@1", root: "r", elements: { r: { type: "Text", props: { text: "Review snapshot" } } } },
    };
    qc.setQueryData(["smart-dynamic", null], { today: "2026-11-06", cards: [card] });
    render(globalView(), { wrapper });
    fireEvent.click(wide ? await screen.findByRole("button", { name: "Fill in" }) : screen.getByRole("button", { name: "Chief of staff" }));
    expect(await screen.findByTestId("dynamic-card")).toBeTruthy();
    expect(screen.queryByTestId("gc-input")).toBeNull();
    act(() => window.dispatchEvent(new CustomEvent(COORDINATOR_PROMPT, { detail: { text: "Plan my week" } })));
    expect(((await screen.findByTestId("gc-input")) as HTMLTextAreaElement).value).toBe("Plan my week");
    expect(screen.getByRole("tabpanel", { name: "Chat" }).hidden).toBe(false);
    expect(screen.queryByTestId("dynamic-card")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("gc-input")));
    expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining("/runs"), expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Fill in" }));
    expect(screen.getByTestId("dynamic-card")).toBeTruthy();
    act(() => window.dispatchEvent(new Event(OPEN_COORDINATOR_EVENT)));
    expect(screen.getByTestId("gc-input")).toBeTruthy();
    expect(screen.queryByTestId("dynamic-card")).toBeNull();
  });

  it("a ⌘K quick action opens the phone sheet and fills the composer without sending", async () => {
    makeClient();
    nav.wide = false;
    render(globalView(), { wrapper });
    await screen.findByRole("button", { name: "Chief of staff" });
    act(() => {
      window.dispatchEvent(new CustomEvent("jarvis:coordinator-prompt", { detail: { text: "Plan my week" } }));
    });
    expect(((await screen.findByTestId("gc-input")) as HTMLTextAreaElement).value).toBe("Plan my week");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("pinned quick actions show above the collapsed tray and open the sheet filled", async () => {
    makeClient();
    nav.wide = false;
    quick = [qa("q1", "Unpinned", "nope"), qa("q2", "Daily brief", "Brief me", true)];
    render(globalView(), { wrapper });
    const tray = await screen.findByTestId("quick-actions-tray");
    expect(within(tray).queryByRole("button", { name: "Unpinned" })).toBeNull();
    expect(within(tray).queryByRole("button", { name: "Manage quick actions" })).toBeNull();
    fireEvent.click(within(tray).getByRole("button", { name: "Daily brief" }));
    expect(((await screen.findByTestId("gc-input")) as HTMLTextAreaElement).value).toBe("Brief me");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("removes context until navigation or Share page, and Ask about this page only fills the draft", async () => {
    makeClient();
    const view = render(globalView(), { wrapper });
    await screen.findByTestId("gc-input");
    const chatPanel = () => within(screen.getByRole("tabpanel", { name: "Chat" }));
    expect(chatPanel().getByText("Viewing: Areas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove page context" }));
    expect(chatPanel().queryByText("Viewing: Areas")).toBeNull();
    // Honest about the off state, and reversible without leaving the page.
    expect(chatPanel().getByText("This page is not shared.")).toBeTruthy();
    fireEvent.click(chatPanel().getByRole("button", { name: "Share page" }));
    expect(chatPanel().getByText("Viewing: Areas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove page context" }));
    nav.path = "/decisions";
    view.rerender(globalView());
    await chatPanel().findByText("Viewing: Needs you");
    // There is no Context tab any more: the composer carries the page chip and its one action.
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Chat", "Needs you", "Activity"]);
    fireEvent.click(screen.getByRole("button", { name: "Ask about this page" }));
    expect((screen.getByTestId("gc-input") as HTMLTextAreaElement).value).toContain("Help me understand this page");
    expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining("/runs"), expect.anything());
    nav.path = "/areas";
    view.rerender(globalView());
    await chatPanel().findByText("Viewing: Areas");
  });
  it("displays and attaches Finance page context", async () => {
    nav.path = "/finance/cards";
    makeClient();
    render(globalView(), { wrapper });
    const input = await screen.findByTestId("gc-input");
    expect(document.querySelector(".gc-context")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ask about this page" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/hermes/sessions/s1/runs",
        expect.objectContaining({ input: expect.stringContaining("[Viewing: Finance › Cards") }),
      ),
    );
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
    // Without a chat panel owning the right side the rail stays open on chat pages.
    expect(screen.getByTestId("gc-rail").style.width).toBe("500px");
    act(() => setPanelOwner("s1"));
    expect(screen.getByTestId("gc-rail").style.width).toBe("54px");
    fireEvent.click(screen.getByRole("button", { name: "Expand Chief of staff" }));
    expect(screen.getByTestId("gc-rail").style.width).toBe("500px");
    expect(document.querySelector<HTMLElement>(".jv-shell")?.style.getPropertyValue("--gc-w")).toBe("500px");
  });
  it.each(["/areas?item=private", "/areas?node=private", "/chat/private-session"])("omits page context for AI-excluded ancestry on %s", async (path) => {
    const url = new URL(path, "http://localhost");
    nav.path = url.pathname;
    nav.search = url.search;
    workItems = [
      { id: "finance", parentId: null, kind: "area", title: "Finance", settings: { aiPolicy: "excluded" } },
      { id: "private", parentId: "finance", kind: "conversation", title: "Private", sessionId: "private-session", settings: null },
    ];
    if (path.startsWith("/chat/")) setPanelOwner(path);
    makeClient();
    render(globalView(), { wrapper });
    if (path.startsWith("/chat/")) fireEvent.click(screen.getByRole("button", { name: "Expand Chief of staff" }));
    await screen.findByTestId("gc-input");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/work/items"));
    expect(document.querySelector(".gc-context")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about this page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share page" })).toBeNull();
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
  it("the phone tray says in one sentence what is going on, and a tap lands on what it points at", async () => {
    nav.wide = false;
    nav.path = "/home";
    info = { ...base, sessionId: "s1" };
    const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    const decision = (seq: number) => ({
      id: `d${seq}`,
      ref: `D-${seq}`,
      seq,
      itemId: `item-${seq}`,
      itemTitle: `Item ${seq}`,
      areaTitle: "Portfolio",
      runId: null,
      question: `Question ${seq}?`,
      choices: ["Yes", "No"],
      recommended: "Yes",
      risk: [],
      pack: {},
      defaultChoice: null,
      expiresAt: null,
      state: "open",
      answeredChoice: null,
      answeredAt: null,
      answeredVia: null,
      deferredUntil: null,
      supersededBy: null,
      raisedBy: "agent:devchief",
      createdAt: iso(90),
      updatedAt: iso(90),
    });
    const runRow = (seq: number, over: Record<string, unknown>) => ({
      id: `run-${seq}`,
      ref: `R-${seq}`,
      seq,
      itemId: "item",
      itemTitle: "Item",
      profile: "devchief",
      title: `Work ${seq}`,
      state: "running",
      stalled: false,
      summary: null,
      prUrl: null,
      parentRunId: null,
      parentRef: null,
      pipeline: [],
      lock: null,
      interruptedAt: null,
      startedAt: iso(300),
      updatedAt: iso(2),
      finishedAt: null,
      noticeCount: 0,
      ...over,
    });
    let looked: string | null = iso(60);
    let runRows = [runRow(1, {}), runRow(2, { state: "failed", title: "Ledger import", updatedAt: iso(5) })];
    const fallback = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path, ...rest) => {
      if (path.startsWith("/api/coordinator/decisions")) return { decisions: [decision(1), decision(2)], counts: { open: 2, deferred: 0 } };
      if (path === "/api/coordinator/runs")
        return { runs: runRows, events: [], lastLooked: { chat: null, needs: null, running: looked, changes: null, context: null } };
      if (path.startsWith("/api/coordinator/runs/")) return { events: [] };
      return fallback(path, ...rest);
    });
    const qc = makeClient();
    render(globalView(), { wrapper });
    const tray = screen.getByRole("button", { name: "Chief of staff" });
    const status = () => document.getElementById(tray.getAttribute("aria-describedby")!)!.textContent;
    // A failure newer than the last look leads and names the run; the rest follows in words, not glyphs.
    await waitFor(() => expect(status()).toBe("Ledger import failed · 2 need you · 1 working"));
    expect(document.querySelector(".gc-tray")?.getAttribute("data-state")).toBe("failed");
    expect(document.querySelector(".jv-shell")?.getAttribute("data-gc-dot")).toBe("red");
    expect(within(document.querySelector<HTMLElement>(".gc-tray")!).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(tray);
    const sheet = screen.getByRole("dialog", { name: "Chief of staff" });
    expect(
      within(sheet)
        .getByRole("tab", { name: /Activity/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // The failed run is under Needs you in Activity (a section of the list, not the Needs you tab).
    const needs = await within(sheet).findByRole("region", { name: "Needs you" });
    expect(needs.getAttribute("data-land")).toBe("needs");
    expect(needs.textContent).toContain("Ledger import");
    expect(within(sheet).getByRole("region", { name: "Working" }).textContent).toContain("Work 1");
    // Once seen it is still counted, but what waits on the owner leads and nothing is red.
    looked = new Date().toISOString();
    runRows = runRows.map((r) => ({ ...r }));
    await act(() => qc.invalidateQueries({ queryKey: ["work", "coordinator", "runs"] }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Close Chief of staff" }));
    await waitFor(() => expect(status()).toBe("2 need you · 1 working · 1 needs a look"));
    expect(document.querySelector(".gc-tray")?.getAttribute("data-state")).toBe("needs");
    expect(document.querySelector(".jv-shell")?.getAttribute("data-gc-dot")).toBe("yellow");
    fireEvent.click(tray);
    expect(
      within(screen.getByRole("dialog", { name: "Chief of staff" }))
        .getByRole("tab", { name: /Needs you/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
  describe("rows in Activity and the one composer", () => {
    const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    const runRow = (seq: number, over: Record<string, unknown> = {}) => ({
      id: `run-${seq}`,
      ref: `R-${seq}`,
      seq,
      itemId: "item",
      itemTitle: "Item",
      profile: "devchief",
      title: "Ledger import",
      state: "running",
      stalled: false,
      summary: null,
      prUrl: null,
      parentRunId: null,
      parentRef: null,
      pipeline: [],
      lock: null,
      interruptedAt: null,
      startedAt: iso(30),
      updatedAt: iso(2),
      finishedAt: null,
      noticeCount: 0,
      ...over,
    });
    /** The phone sheet on Home, with these runs under Activity. */
    async function openActivity(rows: Record<string, unknown>[], sessionId: string | null) {
      nav.wide = false;
      nav.path = "/home";
      info = { ...base, sessionId };
      const fallback = vi.mocked(api.get).getMockImplementation()!;
      vi.mocked(api.get).mockImplementation(async (path, ...rest) => {
        if (path.startsWith("/api/coordinator/decisions")) return { decisions: [], counts: { open: 0, deferred: 0 } };
        if (path === "/api/coordinator/runs")
          return { runs: rows, events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } };
        if (path.startsWith("/api/coordinator/runs/")) return { events: [] };
        return fallback(path, ...rest);
      });
      makeClient();
      render(globalView(), { wrapper });
      fireEvent.click(await screen.findByRole("button", { name: "Chief of staff" }));
      const sheet = screen.getByRole("dialog", { name: "Chief of staff" });
      await within(sheet).findByTestId("gc-input");
      fireEvent.click(within(sheet).getByRole("tab", { name: /Activity/ }));
      await waitFor(() => expect(sheet.querySelector(`[data-run-ref="${rows[0]!.ref}"]`)).toBeTruthy());
      return sheet;
    }
    const rowOf = (sheet: HTMLElement, ref: string) => within(sheet.querySelector<HTMLElement>(`[data-run-ref="${ref}"]`)!);
    const selectedTab = (sheet: HTMLElement) => within(sheet).getByRole("tab", { selected: true }).textContent;
    const composer = (sheet: HTMLElement) => within(sheet).getByTestId("gc-input") as HTMLTextAreaElement;
    /** Everything posted to the assistant: [path, the line sent]. Marking a tab as looked at is not one of them. */
    const sent = () =>
      vi
        .mocked(api.post)
        .mock.calls.filter(([path]) => String(path).startsWith("/api/hermes/"))
        .map(([path, payload]) => [path, (payload as { input?: string } | undefined)?.input]);

    it("Steer on an Activity row switches to Chat with the run's chip in the composer; nothing is sent until Send, then one line goes through the control channel", async () => {
      const sheet = await openActivity([runRow(1)], "s1");
      // The row has no text field: the composer in Chat is the only one.
      expect(rowOf(sheet, "R-1").queryByRole("textbox")).toBeNull();
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Steer R-1" }));
      expect(selectedTab(sheet)).toBe("Chat");
      const chip = within(sheet).getByTestId("gc-scope");
      expect(chip.getAttribute("aria-label")).toBe("Steering R-1: Ledger import");
      expect(chip.querySelector(".k-ref")!.textContent).toBe("R-1");
      // No words are written for the owner, and pressing Steer alone sends nothing.
      expect(composer(sheet).value).toBe("");
      expect(composer(sheet).placeholder).toBe("Steer R-1…");
      await waitFor(() => expect(document.activeElement).toBe(composer(sheet)));
      expect((within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      expect(sent()).toEqual([]);
      fireEvent.change(composer(sheet), { target: { value: "Skip the archive tab" } });
      // typing sends nothing; only Send does
      expect(sent()).toEqual([]);
      fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sent()).toEqual([["/api/hermes/sessions/s1/runs", "Steer R-1 (Ledger import): Skip the archive tab"]]));
      expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/s1/runs", expect.objectContaining({ idempotencyKey: expect.stringMatching(/^ctl-/) }));
      await waitFor(() => expect(within(sheet).queryByTestId("gc-scope")).toBeNull());
      expect(composer(sheet).value).toBe("");
    });
    it("with no conversation yet Steer still only sets the chip; Send starts the conversation with that line", async () => {
      const sheet = await openActivity([runRow(1)], null);
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Steer R-1" }));
      expect(selectedTab(sheet)).toBe("Chat");
      expect(within(sheet).getByTestId("gc-scope").getAttribute("aria-label")).toBe("Steering R-1: Ledger import");
      expect(composer(sheet).value).toBe("");
      // nothing is sent or created by the chip
      expect(sent()).toEqual([]);
      fireEvent.change(composer(sheet), { target: { value: "Skip the archive tab" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sent().map(([path]) => path)).toEqual(["/api/hermes/sessions", "/api/hermes/sessions/s1/runs"]));
      expect(sent()[1]![1]).toMatch(/(^|\n)Steer R-1 \(Ledger import\): Skip the archive tab$/);
      await waitFor(() => expect(within(sheet).queryByTestId("gc-scope")).toBeNull());
    });
    it("Retry on a failed row goes to the composer too, and can be sent as it is", async () => {
      const sheet = await openActivity([runRow(2, { state: "failed", title: "Nightly eval", updatedAt: iso(5) }), runRow(1)], "s1");
      fireEvent.click(rowOf(sheet, "R-2").getByRole("button", { name: "Retry R-2" }));
      expect(selectedTab(sheet)).toBe("Chat");
      const chip = within(sheet).getByTestId("gc-scope");
      expect(chip.getAttribute("aria-label")).toBe("Retry R-2: Nightly eval");
      expect(chip.querySelector(".k-ref")!.textContent).toBe("Retry R-2");
      expect(composer(sheet).value).toBe("");
      expect(composer(sheet).placeholder).toBe("Add a note, or just send");
      // The chip is not the retry: nothing has been sent.
      expect(sent()).toEqual([]);
      const send = within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement;
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(sent()).toEqual([["/api/hermes/sessions/s1/runs", "Retry R-2 (Nightly eval)."]]));
      await waitFor(() => expect(within(sheet).queryByTestId("gc-scope")).toBeNull());
    });
    it("a chip set from Activity is removed by its button or by Backspace in the empty field, and then nothing about the run is sent", async () => {
      const sheet = await openActivity([runRow(1)], "s1");
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Steer R-1" }));
      fireEvent.click(within(sheet).getByRole("button", { name: "Remove R-1 from the message" }));
      expect(within(sheet).queryByTestId("gc-scope")).toBeNull();
      expect(composer(sheet).placeholder).toBe("Ask your chief of staff…");
      fireEvent.click(within(sheet).getByRole("tab", { name: /Activity/ }));
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Steer R-1" }));
      expect(within(sheet).getByTestId("gc-scope")).toBeTruthy();
      fireEvent.keyDown(composer(sheet), { key: "Backspace" });
      expect(within(sheet).queryByTestId("gc-scope")).toBeNull();
      expect(sent()).toEqual([]);
    });
    it("Stop on an Activity row is confirmed on the row, then sent to the conversation as one line; it never goes through the composer", async () => {
      const sheet = await openActivity([runRow(1)], "s1");
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Stop R-1" }));
      const confirm = () => within(sheet).getByRole("group", { name: "Stop R-1 and its sub-agents?" });
      expect(sent()).toEqual([]);
      fireEvent.click(within(confirm()).getByRole("button", { name: "Cancel" }));
      expect(within(sheet).queryByRole("group", { name: "Stop R-1 and its sub-agents?" })).toBeNull();
      expect(sent()).toEqual([]);
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Stop R-1" }));
      fireEvent.click(within(confirm()).getByRole("button", { name: "Stop R-1" }));
      await waitFor(() => expect(sent()).toEqual([["/api/hermes/sessions/s1/runs", "Stop R-1 (Ledger import) and its sub-agents."]]));
      expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/s1/runs", expect.objectContaining({ idempotencyKey: expect.stringMatching(/^ctl-/) }));
      // The owner stays where they were: no tab switch, no chip, nothing written for them.
      await waitFor(() => expect(within(sheet).queryByRole("group", { name: "Stop R-1 and its sub-agents?" })).toBeNull());
      expect(selectedTab(sheet)).toMatch(/^Activity/);
      expect(within(sheet).queryByTestId("gc-scope")).toBeNull();
      expect(composer(sheet).value).toBe("");
    });
    it("with no conversation to send a stop through, confirming writes the request into the composer for the owner to send", async () => {
      const sheet = await openActivity([runRow(1)], null);
      fireEvent.click(rowOf(sheet, "R-1").getByRole("button", { name: "Stop R-1" }));
      fireEvent.click(within(within(sheet).getByRole("group", { name: "Stop R-1 and its sub-agents?" })).getByRole("button", { name: "Stop R-1" }));
      await waitFor(() => expect(composer(sheet).value).toBe("Stop R-1 (Ledger import) and its sub-agents."));
      expect(selectedTab(sheet)).toBe("Chat");
      expect(within(sheet).queryByTestId("gc-scope")).toBeNull();
      // nothing is sent or created until the owner sends it
      expect(sent()).toEqual([]);
    });
  });
  it("Needs you counts what Today counts: approvals and stalled runs are listed with the decisions, stalled ones link to Activity", async () => {
    info = { ...base, sessionId: "s1" };
    const fallback = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path, ...rest) => {
      if (path === "/api/work/decisions")
        return {
          count: 2,
          entries: [
            {
              key: "approval:run_1",
              kind: "approval",
              title: "Hermes needs your approval",
              question: "Recursive delete",
              choices: [],
              href: "/chat/s9",
              at: new Date().toISOString(),
            },
            {
              key: "stalled:run-7",
              kind: "stalled",
              title: "Ledger",
              question: "@devchief's run \"Ledger import\" hasn't reported in over 30 min.",
              choices: [],
              href: "/areas?item=i7",
              at: new Date().toISOString(),
              itemId: "i7",
            },
          ],
        };
      if (path.startsWith("/api/coordinator/decisions")) return { decisions: [], counts: { open: 0, deferred: 0 } };
      if (path === "/api/coordinator/runs")
        return { runs: [], events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } };
      return fallback(path, ...rest);
    });
    makeClient();
    render(globalView(), { wrapper });
    const tab = await screen.findByRole("tab", { name: /Needs you\s*2/ });
    fireEvent.click(tab);
    const panel = within(screen.getByRole("tabpanel", { name: /Needs you/ }));
    expect((await panel.findByRole("region", { name: "Approvals and proposals" })).textContent).toContain("Recursive delete");
    const stalled = panel.getByRole("region", { name: "Runs to check" });
    // The shared word for silence, then what is known and where to look.
    expect(within(stalled).getByText("1 run stalled")).toBeTruthy();
    expect(stalled.textContent).toContain("No report for over 30 minutes · check in Activity");
    // With other things waiting, an empty decision queue does not claim that nothing needs the owner.
    expect(panel.getByText("No open decisions")).toBeTruthy();
    expect(panel.queryByText("Nothing needs you")).toBeNull();
    fireEvent.click(within(stalled).getByRole("button"));
    expect(screen.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")).toBe("true");
  });
  it("what a reply mentions is drawn under it in Chat: the open decision first, then runs by need; each row and chip opens the right place", async () => {
    nav.path = "/home";
    info = { ...base, sessionId: "s1" };
    const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
    const decision = {
      id: "d1",
      ref: "D-1",
      seq: 1,
      itemId: "item-1",
      itemTitle: "Frames",
      areaTitle: "Portfolio",
      runId: null,
      question: "Which frame should I order?",
      choices: ["Oak", "Walnut"],
      recommended: "Oak",
      risk: [],
      pack: {},
      defaultChoice: null,
      expiresAt: null,
      state: "open",
      answeredChoice: null,
      answeredAt: null,
      answeredVia: null,
      deferredUntil: null,
      supersededBy: null,
      raisedBy: "agent:devchief",
      createdAt: iso(90),
      updatedAt: iso(90),
    };
    const runRow = (seq: number, over: Record<string, unknown>) => ({
      id: `run-${seq}`,
      ref: `R-${seq}`,
      seq,
      itemId: "item",
      itemTitle: "Item",
      profile: "devchief",
      title: `Work ${seq}`,
      state: "running",
      stalled: false,
      summary: null,
      prUrl: null,
      parentRunId: null,
      parentRef: null,
      pipeline: [],
      lock: null,
      interruptedAt: null,
      startedAt: iso(300),
      updatedAt: iso(2),
      finishedAt: null,
      noticeCount: 0,
      ...over,
    });
    const fallback = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path, ...rest) => {
      if (path.startsWith("/api/coordinator/decisions")) return { decisions: [decision], counts: { open: 1, deferred: 0 } };
      if (path === "/api/coordinator/runs")
        return {
          runs: [runRow(3, {}), runRow(2, { state: "failed", title: "Ledger import", updatedAt: iso(5) })],
          events: [],
          lastLooked: { chat: null, needs: null, running: iso(1), changes: null, context: null },
        };
      if (path.startsWith("/api/coordinator/runs/")) return { events: [] };
      if (path.startsWith("/api/hermes/sessions/s1/execution")) return { sessionId: "s1", parent: null, records: [], sources: [] };
      if (path.startsWith("/api/hermes/sessions/"))
        return {
          session: { id: "s1", pinned: false, archived: false },
          timeline: [
            { kind: "user", id: "u1", text: "Where do things stand?", at: iso(11) },
            {
              kind: "assistant",
              id: "a1",
              text: "Status: R-3 is moving, R-2 failed and D-1 needs you. D-9 is answered and R-99 is not one of mine.",
              at: iso(10),
            },
          ],
        };
      return fallback(path, ...rest);
    });
    makeClient();
    render(globalView(), { wrapper });
    const chat = await screen.findByRole("tabpanel", { name: "Chat" });
    const section = await within(chat).findByRole("region", { name: "Mentioned in this reply" });
    const rows = () =>
      Array.from(section.querySelectorAll("[data-ref-row], article[data-run-ref]")).map(
        (el) => el.getAttribute("data-ref-row") ?? el.getAttribute("data-run-ref"),
      );
    // What waits on the owner, then what failed, then what is moving; a closed decision and an unknown run have no row.
    await waitFor(() => expect(rows()).toEqual(["D-1", "R-2", "R-3"]));
    // Every reference is a chip in the text all the same, in the order written.
    const reply = within(chat).getByText(/^Status:/);
    expect(Array.from(reply.querySelectorAll(".gc-inline-ref")).map((el) => el.textContent)).toEqual(["R-3", "R-2", "D-1", "D-9", "R-99"]);
    const selected = () => screen.getByRole("tab", { selected: true }).textContent;
    // A chip whose row is right here lands on it and stays in Chat.
    const failed = section.querySelector<HTMLElement>('article[data-run-ref="R-2"]')!;
    fireEvent.click(within(reply).getByRole("button", { name: "Run R 2" }));
    expect(failed.hasAttribute("data-landed")).toBe(true);
    const decisionRow = section.querySelector<HTMLElement>('[data-ref-row="D-1"]')!;
    fireEvent.click(within(reply).getByRole("button", { name: "Decision D 1" }));
    expect(decisionRow.hasAttribute("data-landed")).toBe(true);
    expect(selected()).toBe("Chat");
    // The run rows are the same rows as in Activity, with the same actions: Retry puts the run in the composer here.
    expect(failed.textContent).toContain("Failed");
    fireEvent.click(within(failed).getByRole("button", { name: "Retry R-2" }));
    expect(selected()).toBe("Chat");
    expect(within(chat).getByTestId("gc-scope").getAttribute("aria-label")).toBe("Retry R-2: Ledger import");
    // Stop asks on that row, and its confirmation is its own.
    const moving = section.querySelector<HTMLElement>('article[data-run-ref="R-3"]')!;
    fireEvent.click(within(moving).getByRole("button", { name: "Stop R-3" }));
    fireEvent.click(within(within(moving).getByRole("group", { name: "Stop R-3 and its sub-agents?" })).getByRole("button", { name: "Cancel" }));
    expect(within(chat).queryByRole("group", { name: /^Stop R-/ })).toBeNull();
    expect(vi.mocked(api.post).mock.calls.some(([path]) => String(path).startsWith("/api/hermes/"))).toBe(false);
    // The decision row says its state in the shared words; its title opens the decision under Needs you.
    expect(decisionRow.textContent).toContain("Needs you");
    expect(decisionRow.textContent).toContain("Frames");
    fireEvent.click(within(decisionRow).getByRole("button", { name: "Which frame should I order?" }));
    expect(selected()).toMatch(/^Needs you/);
    expect(within(screen.getByRole("tabpanel", { name: /Needs you/ })).getAllByText("Which frame should I order?").length).toBeGreaterThan(0);
    // A reference with no row in the conversation opens its tab: an unknown run goes to Activity.
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    fireEvent.click(within(reply).getByRole("button", { name: "Run R 99" }));
    expect(selected()).toMatch(/^Activity/);
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    fireEvent.click(within(reply).getByRole("button", { name: "Decision D 9" }));
    expect(selected()).toMatch(/^Needs you/);
  });
  it("renders the no-area setup link without a send control", async () => {
    info = { area: null };
    makeClient();
    render(globalView(), { wrapper });
    expect(await screen.findByText(/No Chief of staff yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings → Agents" }).getAttribute("href")).toBe("/settings/agents");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("shows recent attributed action cards under Activity → Changes only (none under a reply in Chat), and calls the existing undo endpoint", async () => {
    info = { ...base, sessionId: "s1" };
    activity = [action("new", "chiefofstaff"), action("old", "chiefofstaff", new Date(Date.now() - 10000).toISOString()), action("other", "devchief")];
    makeClient();
    render(globalView(), { wrapper });
    await screen.findByTestId("gc-input");
    const chatPanel = screen.getByRole("tabpanel", { name: "Chat" });
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    const changes = within(screen.getByRole("tabpanel", { name: /Activity/ })).getByRole("region", { name: "Changes" });
    // Each touched item is a card (its title opens the card; "Open item" is inside).
    expect(await within(changes).findByText("Item new")).toBeTruthy();
    expect(within(changes).getByText("Item old")).toBeTruthy();
    expect(within(changes).queryByText("Item other")).toBeNull();
    expect(within(changes).getAllByRole("list", { name: /^Changes to Item / })).toHaveLength(2);
    // The changes have loaded, and the conversation draws none of them: Chat is the messages and their work rows.
    expect(chatPanel.hidden).toBe(true);
    expect(await within(chatPanel).findByText("Hello")).toBeTruthy();
    expect(within(chatPanel).queryByText("Item new")).toBeNull();
    expect(chatPanel.querySelector("article")).toBeNull();
    fireEvent.click(within(changes).getByRole("button", { name: "Undo Created item: Item new" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/work/ops/op-new/undo"));
  });
  it("Ask in chat on a changed item switches to Chat with the item in the composer; nothing is typed for the owner and nothing is sent", async () => {
    info = { ...base, sessionId: "s1" };
    activity = [action("new", "chiefofstaff")];
    makeClient();
    render(globalView(), { wrapper });
    await screen.findByTestId("gc-input");
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    const changes = within(screen.getByRole("tabpanel", { name: /Activity/ })).getByRole("region", { name: "Changes" });
    fireEvent.contextMenu((await within(changes).findByText("Item new")).closest("article")!, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask in chat" }));
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("group", { name: "About Item new" })).toBe(screen.getByTestId("gc-scope"));
    const input = screen.getByTestId("gc-input") as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Ask about this work…");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(vi.mocked(api.post).mock.calls.some(([path]) => String(path).startsWith("/api/hermes/"))).toBe(false);
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
