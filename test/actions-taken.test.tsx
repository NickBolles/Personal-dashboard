// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsTaken, OPEN_CHAT_RUNNING } from "@/components/chat/ActionsTaken";
import { CoordinatorThread, type CoordinatorResponse } from "@/components/coordinator/CoordinatorThread";
import { api } from "@/lib/client/api";
import type { ChatAction } from "@/lib/chat/actions";
import type { ChatExecutionResponse, ExecutionRecord } from "@/lib/chat-execution";
import type { CoordinatorRunRow, RunsResponse } from "@/lib/coordinator/runs-view";
import type { SessionSummary, TimelineItem } from "@/lib/hermes";


const mocks = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => "/areas" }));
vi.mock("@/components/ui", async (original) => ({ ...(await original<object>()), useToast: () => ({ toast: mocks.toast, announce: vi.fn() }) }));

let qc: QueryClient;
let activeRun: SessionSummary["activeRun"];
let records: ExecutionRecord[];
let trackedRuns: CoordinatorRunRow[];
let conversations: { id: string; title: string; placement: { parentId: string } }[];
let timeline: TimelineItem[];
const at = "2026-11-07T20:00:00.000Z";
const action = (extra: Partial<ChatAction> = {}): ChatAction => ({
  id: "t1:created",
  kind: "created",
  label: "Created",
  title: "Retry policy",
  itemId: "wk_retry",
  runId: null,
  undoOpId: "op_retry",
  href: "/areas?item=wk_retry",
  at,
  ...extra,
});
const record = (extra: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  key: "subagent:sa_1",
  source: "subagent",
  id: "sa_1",
  title: "Audit retry policy",
  state: "running",
  startedAt: at,
  href: "/chat/child",
  ...extra,
});
const info: CoordinatorResponse = {
  area: { id: "wk_area", title: "Jarvis" },
  agent: { requested: "devchief", profile: "devchief", routed: true, reason: "routed" },
  sessionId: "s1",
  sessionTitle: "Jarvis coordinator",
  excluded: false,
  prompt: "Catch me up",
  lastRunAt: at,
};
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  activeRun = undefined;
  records = [record()];
  trackedRuns = [];
  conversations = [];
  timeline = [{ kind: "assistant", id: "a1", text: "Ready to proceed.", at }];
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path.endsWith("/execution")) return { sessionId: "s1", parent: null, records, sources: [], fetchedAt: at } satisfies ChatExecutionResponse;
    if (path.startsWith("/api/hermes/sessions/")) return { session: { id: "s1", activeRun }, timeline };
    if (path.startsWith("/api/work/conversations?")) return { conversations, unavailable: [] };
    if (path === "/api/coordinator/runs")
      return { runs: trackedRuns, events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } } satisfies RunsResponse;
    if (path === "/api/quick-actions") return { actions: [] };
    if (path.startsWith("/api/feedback")) return { entries: [] };
    throw new Error(`Unexpected API path: ${path}`);
  });
  vi.spyOn(api, "post").mockResolvedValue({ id: "focus_session" });
  vi.spyOn(api, "put").mockResolvedValue({ areaId: "wk_area", sessionId: "s1", pinned: true, previous: null });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.restoreAllMocks();
});

const openChip = (name = "Created · Retry policy") => fireEvent.click(screen.getByRole("button", { name }));

describe("ActionsTaken", () => {
  it("renders no row without actions and uses full accessible chip titles with compact visible text", () => {
    const view = render(<ActionsTaken actions={[]} />, { wrapper });
    expect(screen.queryByTestId("actions-taken")).toBeNull();
    const title = "A deliberately long policy title that stays available to assistive technology";
    view.rerender(<ActionsTaken actions={[action({ title })]} compact areaHint="Jarvis" />);
    const chip = screen.getByRole("button", { name: `Created · ${title}` });
    expect(chip.title).toBe(`Created · ${title}`);
    expect(chip.textContent).toBe(`Created · ${title.slice(0, 39)}…`);
    expect(screen.getByRole("group", { name: "Actions in Jarvis" })).toBeTruthy();
    // Done = solid agent outline; only something merely proposed keeps the dashed "proposed" outline.
    expect(chip.className).not.toContain("border-dashed");
    view.rerender(<ActionsTaken actions={[action({ kind: "quick_action", label: "Quick action proposed", undoOpId: null })]} />);
    expect(screen.getByRole("button", { name: "Proposed a quick action · Retry policy" }).className).toContain("border-dashed");
  });
  it("summarises several actions in one plain line and lists them, repeats folded, only on request", () => {
    const run = (id: string) => action({ id, kind: "run_started", label: "Run started", title: null, runId: id, undoOpId: null });
    const delegated = action({ id: "d", kind: "delegated", label: "2 sub-agents", title: "Audit retries", count: 2, href: null, itemId: null, undoOpId: null });
    render(<ActionsTaken actions={[action(), run("arun_1"), run("arun_2"), delegated, action({ id: "u", kind: "updated", label: "Updated" })]} />, { wrapper });
    const summary = screen.getByRole("button", { name: "Created 1 item, started 2 runs, handed off to 2 agents, +1 more" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(screen.getByRole("list", { name: "What was done" }))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Created · Retry policy", "Started 2 runs", "Handed off to 2 agents · Audit retries", "Updated · Retry policy"]);
    // Every row still opens what it opened before.
    openChip("Updated · Retry policy");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(mocks.push).toHaveBeenCalledWith("/areas?item=wk_retry");
    fireEvent.click(summary);
    expect(screen.queryByRole("list", { name: "What was done" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("opens internal paths through the router and closes the menu with focus restored", () => {
    render(<ActionsTaken actions={[action()]} />, { wrapper });
    openChip();
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open", "Undo", "Focus"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open" }));
    expect(mocks.push).toHaveBeenCalledWith("/areas?item=wk_retry");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Created · Retry policy" }));
  });
  it("opens https links in a protected new tab and rejects unsafe paths", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = render(<ActionsTaken actions={[action({ href: "https://example.com/report" })]} />, { wrapper });
    openChip();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(open).toHaveBeenCalledWith("https://example.com/report", "_blank", "noopener,noreferrer");
    view.rerender(<ActionsTaken actions={[action({ href: "javascript:alert(1)", undoOpId: null, itemId: null })]} />);
    openChip();
    expect((screen.getByRole("menuitem", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Focus" })).toBeNull();
  });
  it("calls Undo without confirmation, invalidates both ledgers and disables it after success", async () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    render(<ActionsTaken actions={[action()]} />, { wrapper });
    openChip();
    fireEvent.click(screen.getByRole("menuitem", { name: "Undo" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Undone", "ok"));
    expect(api.post).toHaveBeenCalledWith("/api/work/ops/op_retry/undo");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activity"] });
    openChip();
    expect((screen.getByRole("menuitem", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("reports a rejected Undo and keeps it retryable", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error("Undo window expired"));
    render(<ActionsTaken actions={[action()]} />, { wrapper });
    openChip();
    fireEvent.click(screen.getByRole("menuitem", { name: "Undo" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Not undone: Undo window expired", "danger"));
    openChip();
    expect((screen.getByRole("menuitem", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("creates a focused conversation filed under the action item then navigates to it", async () => {
    render(<ActionsTaken actions={[action()]} />, { wrapper });
    openChip();
    fireEvent.click(screen.getByRole("menuitem", { name: "Focus" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/chat/focus_session"));
    expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions", { title: "Focus: Retry policy", areaId: "wk_retry" });
  });
  it("reports a failed Focus without navigating", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error("Offline"));
    render(<ActionsTaken actions={[action()]} />, { wrapper });
    openChip();
    fireEvent.click(screen.getByRole("menuitem", { name: "Focus" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Couldn't focus: Offline", "danger"));
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("opens delegated work through the session-scoped Running event or link", () => {
    const delegated = action({ kind: "delegated", label: "2 sub-agents", count: 2, title: null, href: null, itemId: null, undoOpId: null });
    const handler = vi.fn();
    window.history.replaceState({}, "", "/chat/s1");
    window.addEventListener(OPEN_CHAT_RUNNING, handler);
    const view = render(<ActionsTaken actions={[delegated]} sessionId="s1" />, { wrapper });
    openChip("Handed off to 2 agents");
    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: "s1" });
    window.removeEventListener(OPEN_CHAT_RUNNING, handler);
    window.history.replaceState({}, "", "/areas");
    openChip("Handed off to 2 agents");
    expect(mocks.push).toHaveBeenCalledWith("/chat/s1?panel=running");
    view.rerender(<ActionsTaken actions={[delegated]} />);
    expect((screen.getByRole("button", { name: "Handed off to 2 agents" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("closes on Escape and outside clicks", () => {
    render(<ActionsTaken actions={[action()]} />, { wrapper });
    openChip();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    openChip();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("coordinator parity controls", () => {
  const cards = () => screen.queryAllByTestId("coordinator-run-card");

  it("stops an active parent run using the direct stop endpoint", async () => {
    activeRun = { runId: "run_parent", status: "running" };
    records = [];
    render(<CoordinatorThread info={info} />, { wrapper });
    expect(await screen.findByText("Working…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/runs/run_parent/stop"));
    expect(mocks.toast).toHaveBeenCalledWith("Stop requested");
  });
  it("keeps background-work inventory out of Chat while preserving the conversation's own action record", async () => {
    records = [
      record({ key: "unknown", id: "sa_a", title: "Work A", state: "unknown" }),
      record({ key: "registered", id: "reg_b", title: "Work B", source: "registered_run" }),
      record({ key: "unsafe", title: "Work C", id: "bad id" }),
      record({ key: "jarvis", id: "run_d", title: "Work D", source: "jarvis_run", state: "waiting" }),
      record({ key: "finished", id: "sa_e", title: "Work E", state: "completed" }),
      record({ key: "sixth", id: "sa_f", title: "Work F", state: "completed" }),
      record({ key: "process", id: "proc_g", title: "Work G", source: "process" }),
    ];
    render(<CoordinatorThread info={info} />, { wrapper });
    await waitFor(() => expect(screen.getByRole("list", { name: "Latest messages" })).toBeTruthy());
    // Background-work cards, including waiting and failed work, are only in Tasks / dedicated views.
    expect(cards()).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Work started by this reply" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Work in progress" })).toBeNull();
    // No background control leaks into the transcript inventory.
    expect(screen.queryByRole("button", { name: /^(Steer|Stop)/ })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("does not inject stalled or failed background work into Chat", async () => {
    records = [
      record({ key: "sub", updatedAt: at }),
      record({ key: "reg", source: "registered_run", id: "reg_1", state: "unknown" }),
      record({ key: "other", id: "sa_2", title: "Draft the email", state: "failed", error: "(no summary — status=failed: vendor portal timed out)" }),
    ];
    render(<CoordinatorThread info={info} />, { wrapper });
    await waitFor(() => expect(screen.getByRole("list", { name: "Latest messages" })).toBeTruthy());
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText("Draft the email")).toBeNull();
    expect(screen.queryByText(/status=failed/)).toBeNull();
    expect(screen.queryByTestId("gc-scope")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("keeps hand-off history and routes every referenced run to its dedicated view", async () => {
    const t = (min: number) => new Date(Date.parse(at) + min * 60_000).toISOString();
    timeline = [
      { kind: "assistant", id: "a1", text: "Handed off the audit as R-7. Also see R-9 and D-4.", at: t(-58) },
      { kind: "assistant", id: "a2", text: "Filed.", at: t(-28) },
    ];
    records = [record({ key: "subagent:sa_1", id: "sa_1", title: "Audit retry policy", startedAt: t(-59) })];
    const onRef = vi.fn();
    render(<CoordinatorThread info={info} onRef={onRef} />, { wrapper });
    const reply = await screen.findByText(/^Handed off the audit as/);
    expect(screen.queryByTestId("coordinator-run-card")).toBeNull();
    expect(screen.queryByRole("region", { name: "Work started by this reply" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Work in progress" })).toBeNull();
    // The action history and reference chips remain in the actual transcript.
    const row = reply.closest("li")!;
    expect(Array.from(row.querySelectorAll<HTMLElement>(".gc-inline-ref")).map((b) => b.textContent)).toEqual(["R-7", "R-9", "D-4"]);
    fireEvent.click(within(row).getByRole("button", { name: "Run R 7" }));
    fireEvent.click(within(row).getByRole("button", { name: "Run R 9" }));
    fireEvent.click(within(row).getByRole("button", { name: "Decision D 4" }));
    expect(onRef.mock.calls).toEqual([["R-7"], ["R-9"], ["D-4"]]);
  });
  it("groups actions under replies and renders a live group without parsing the Markdown footer", async () => {
    const tool = (id: string): TimelineItem => ({
      kind: "tool",
      id,
      tool: "mcp__jarvis__jarvis_create_item",
      summary: "",
      detail: JSON.stringify({ item: { id: "wk_retry", title: "Retry policy" } }),
      at,
    });
    timeline = [
      tool("t1"),
      { kind: "assistant", id: "a1", text: "**Current state:** Ready\n\n**Next action:** Verify\n\n**Decisions:** None", at },
      tool("t2"),
    ];
    render(<CoordinatorThread info={info} />, { wrapper });
    await waitFor(() => expect(screen.getAllByTestId("actions-taken")).toHaveLength(2));
    expect(screen.getByText("Current state:").tagName).toBe("STRONG");
  });
  it("draws only this area's own earlier threads above the chat, as dividers; New forces creation instead of reusing the old session", async () => {
    conversations = [
      { id: "s1", title: "Current", placement: { parentId: "wk_area" } },
      { id: "nested", title: "Nested conversation", placement: { parentId: "wk_project" } },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `old${i}`, title: `Earlier ${i}`, placement: { parentId: "wk_area" } })),
    ];
    render(<CoordinatorThread info={info} />, { wrapper });
    // No fold-out list: the newest earlier thread is a divider at the top of the chat that loads it in place.
    expect(screen.queryByText("Earlier threads", { exact: true })).toBeNull();
    await screen.findByRole("button", { name: "Earlier" });
    expect(api.get).toHaveBeenCalledWith("/api/work/conversations?view=all&areaId=wk_area");
    expect(screen.queryByRole("list", { name: "Earlier threads" })).toBeNull();
    // One divider at a time; never a /chat link; direct children only, never the current one.
    expect(screen.getAllByRole("button", { name: "Earlier" })).toHaveLength(1);
    expect(within(screen.getByTestId("gc-earlier")).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText(/Nested conversation/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Earlier" }));
    expect(await screen.findByRole("region", { name: "Earlier thread: Earlier 0" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Earlier thread: Current" })).toBeNull();
    // New thread asks first; nothing is created until the first message.
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByTestId("coordinator-input")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start new thread" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("coordinator-empty")).toBeTruthy();
    fireEvent.change(screen.getByTestId("coordinator-input"), { target: { value: "Fresh scope" } });
    fireEvent.click(screen.getByTestId("coordinator-send"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/focus_session/runs", expect.objectContaining({ input: "Fresh scope" })));
    // The thread the panel starts becomes the pinned Chief of staff thread.
    expect(api.put).toHaveBeenCalledWith("/api/work/items/wk_area/coordinator", { sessionId: "focus_session" });
    expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions", { title: "Jarvis coordinator", areaId: "wk_area" });
  });
});
