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
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";

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
  const cards = () => screen.getAllByTestId("coordinator-run-card");
  const composer = () => screen.getByTestId("coordinator-input") as HTMLTextAreaElement;
  it.each([false, true])(
    "Steer on a row puts its chip in the one composer; Send goes through the parent when active=%s, then the composer clears",
    async (active) => {
      if (active) activeRun = { runId: "run_parent", status: "running" };
      render(<CoordinatorThread info={info} />, { wrapper });
      const card = await screen.findByTestId("coordinator-run-card");
      expect(card.getAttribute("data-state")).toBe("running");
      expect(card.textContent).toContain("Working");
      // The row has no text field of its own: the composer is the only one.
      expect(within(card).queryByRole("textbox")).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: "Steer Audit retry policy" }));
      // Steer alone sends nothing: it says what the next message is about.
      expect(api.post).not.toHaveBeenCalled();
      expect(screen.getByTestId("gc-scope").getAttribute("aria-label")).toBe("Steering Audit retry policy");
      expect(composer().placeholder).toBe("Steer this work…");
      fireEvent.change(composer(), { target: { value: "  Focus on\n tests " } });
      expect(api.post).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("coordinator-send"));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Sent to the coordinator"));
      expect(api.post).toHaveBeenCalledExactlyOnceWith(
        active ? "/api/hermes/runs/run_parent/steer" : "/api/hermes/sessions/s1/runs",
        active
          ? { input: "Steer sa_1: Focus on tests" }
          : {
              input: "Steer sa_1: Focus on tests",
              idempotencyKey: expect.stringMatching(/^ctl-/),
              capabilities: [SMART_CAPABILITY],
            },
      );
      await waitFor(() => expect(screen.queryByTestId("gc-scope")).toBeNull());
      expect(composer().value).toBe("");
    },
  );
  it("what was already typed stays in the composer when a row is steered, and goes with it only on Send", async () => {
    render(<CoordinatorThread info={info} />, { wrapper });
    const card = await screen.findByTestId("coordinator-run-card");
    fireEvent.change(composer(), { target: { value: "Keep this draft" } });
    fireEvent.click(within(card).getByRole("button", { name: "Steer Audit retry policy" }));
    expect(composer().value).toBe("Keep this draft");
    expect(api.post).not.toHaveBeenCalled();
    // Taking the chip off again leaves an ordinary draft.
    fireEvent.click(screen.getByRole("button", { name: "Remove Audit retry policy from the message" }));
    expect(screen.queryByTestId("gc-scope")).toBeNull();
    expect(composer().value).toBe("Keep this draft");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("requires confirmation before asking the coordinator to stop a sub-agent", async () => {
    render(<CoordinatorThread info={info} />, { wrapper });
    const card = await screen.findByTestId("coordinator-run-card");
    fireEvent.click(within(card).getByRole("button", { name: "Stop Audit retry policy" }));
    expect(api.post).not.toHaveBeenCalled();
    // The confirm says what the second tap does: it sends the request.
    const confirm = () => within(card).getByRole("group", { name: "Stop Audit retry policy?" });
    expect(confirm().textContent).toContain("as soon as you confirm");
    fireEvent.click(within(confirm()).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Stop Audit retry policy" }));
    fireEvent.click(within(confirm()).getByRole("button", { name: "Stop sub-agent" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledExactlyOnceWith(
        "/api/hermes/sessions/s1/runs",
        expect.objectContaining({ input: "Stop sa_1", idempotencyKey: expect.stringMatching(/^ctl-/) }),
      ),
    );
    // Stop does not go through the composer.
    expect(screen.queryByTestId("gc-scope")).toBeNull();
    expect(composer().value).toBe("");
  });
  it("stops an active parent run using the direct stop endpoint", async () => {
    activeRun = { runId: "run_parent", status: "running" };
    records = [];
    render(<CoordinatorThread info={info} />, { wrapper });
    expect(await screen.findByText("Working…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/runs/run_parent/stop"));
    expect(mocks.toast).toHaveBeenCalledWith("Stop requested");
  });
  it("draws every piece of work as a row, preserves unknown status and never offers controls for registered or unsafe IDs", async () => {
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
    // Every sub-agent, registered run and job is a row (a background process is not); nothing is cut off behind a link.
    await waitFor(() => expect(cards()).toHaveLength(6));
    // What needs the owner first, then what is in flight, then what is not known, then what ended.
    expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual(["Work D", "Work B", "Work C", "Work A", "Work E", "Work F"]);
    expect(cards().map((c) => c.getAttribute("data-state"))).toEqual(["waiting", "running", "running", "unknown", "completed", "completed"]);
    // They all started with the one reply on screen, so they sit under it; there is no separate list or heading.
    expect(within(screen.getByRole("region", { name: "Work started by this reply" })).getAllByTestId("coordinator-run-card")).toHaveLength(6);
    expect(screen.queryByRole("region", { name: "Work in progress" })).toBeNull();
    expect(screen.queryByText("Background work")).toBeNull();
    expect(screen.queryByRole("link", { name: /\bmore$/ })).toBeNull();
    // Work that has not reported says so, instead of claiming to be working.
    const quiet = cards()[3]!;
    expect(quiet.textContent).toContain("No report yet");
    expect(quiet.textContent).not.toContain("Working");
    expect(quiet.getAttribute("data-live")).toBeNull();
    // (its third line says so; there is nothing more to open)
    expect(quiet.textContent).toMatch(/hasn't reported yet/);
    expect(within(quiet).queryByRole("button", { name: /^Details for/ })).toBeNull();
    // None of these can be reached: no Steer and no Stop anywhere.
    expect(screen.queryByRole("button", { name: /^(Steer|Stop)/ })).toBeNull();
    // The job that waits can still be answered.
    expect(within(cards()[0]!).getByRole("button", { name: "Reply to Work D" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("shows one row per piece of work: a record with no status folds into its twin", async () => {
    records = [
      record({ key: "sub", updatedAt: at }),
      record({ key: "reg", source: "registered_run", id: "reg_1", state: "unknown" }),
      record({ key: "other", id: "sa_2", title: "Draft the email", state: "failed", error: "(no summary — status=failed: vendor portal timed out)" }),
    ];
    render(<CoordinatorThread info={info} />, { wrapper });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.queryByText("No report yet")).toBeNull();
    const failed = screen.getByRole("article", { name: "Draft the email" });
    expect(failed.getAttribute("data-state")).toBe("failed");
    // A raw fallback from the source reads as a sentence.
    expect(failed.textContent).toContain("Vendor portal timed out");
    expect(screen.queryByText(/status=failed/)).toBeNull();
    // A sub-agent whose last report is days old has stalled; that is said in the shared word.
    const silent = screen.getByRole("article", { name: "Audit retry policy" });
    expect(silent.getAttribute("data-state")).toBe("stuck");
    expect(silent.textContent).toMatch(/Stalled · no report for \d+ d/);
    // Work that failed cannot be steered, but it can be answered: Reply puts it in the composer and sends a line about it.
    expect(within(failed).queryByRole("button", { name: /^Steer/ })).toBeNull();
    fireEvent.click(within(failed).getByRole("button", { name: "Reply to Draft the email" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(within(failed).queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("group", { name: "About Draft the email" })).toBe(screen.getByTestId("gc-scope"));
    expect(composer().placeholder).toBe("Ask about this work…");
    fireEvent.change(composer(), { target: { value: " Use the  posted amount " } });
    fireEvent.click(screen.getByTestId("coordinator-send"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledExactlyOnceWith(
        "/api/hermes/sessions/s1/runs",
        expect.objectContaining({ input: 'About "Draft the email": Use the posted amount' }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("gc-scope")).toBeNull());
  });
  it("draws work once, under the reply that started it; a hand-off that has its row is not also an action chip, and its R-n in the text jumps to the row", async () => {
    const t = (min: number) => new Date(Date.parse(at) + min * 60_000).toISOString();
    const tool = (id: string, name: string, input: object, detail: object, min: number): TimelineItem => ({
      kind: "tool",
      id,
      tool: name,
      summary: "",
      input: JSON.stringify(input),
      detail: JSON.stringify(detail),
      at: t(min),
    });
    timeline = [
      { kind: "user", id: "u0", text: "Audit the retry policy", at: t(-90) },
      tool("d1", "delegate_task", { goal: "Audit retry policy" }, { delegation_id: "del_1", subagent_ids: ["sa_1"] }, -59),
      tool("r1", "mcp__jarvis__jarvis_run_start", { title: "Audit retry policy" }, { runId: "arun_1" }, -59),
      { kind: "assistant", id: "a1", text: "Handed off the audit as R-7. Also see R-9 and D-4.", at: t(-58) },
      { kind: "user", id: "u1", text: "And file the follow-up", at: t(-30) },
      tool("c1", "mcp__jarvis__jarvis_create_item", {}, { item: { id: "wk_retry", title: "Retry policy" } }, -29),
      { kind: "assistant", id: "a2", text: "Filed.", at: t(-28) },
    ];
    const started = [
      record({ delegationId: "del_1", subagentId: "sa_1", startedAt: t(-59) }),
      record({ key: "registered_run:run-7", source: "registered_run", id: "run-7", delegationId: "del_1:sa_1", startedAt: t(-59) }),
    ];
    records = [
      ...started,
      // from before the messages on screen: one that ended back then, one that is still going
      record({ key: "subagent:sa_old", id: "sa_old", title: "Old audit", state: "completed", startedAt: t(-600), endedAt: t(-590) }),
      record({ key: "subagent:sa_long", id: "sa_long", title: "Long crawl", startedAt: t(-600) }),
      // started after the last reply: its turn has not answered yet
      record({ key: "subagent:sa_new", id: "sa_new", title: "Fresh job", startedAt: t(-5) }),
    ];
    trackedRuns = [
      {
        id: "run-7",
        ref: "R-7",
        seq: 7,
        itemId: "wk_retry",
        itemTitle: "Retry policy",
        profile: "devchief",
        title: "Audit retry policy",
        state: "running",
        stalled: false,
        summary: null,
        prUrl: null,
        parentRunId: null,
        parentRef: null,
        pipeline: [],
        lock: null,
        interruptedAt: null,
        startedAt: t(-59),
        updatedAt: t(-40),
        finishedAt: null,
        noticeCount: 0,
      },
    ];
    const onRef = vi.fn();
    const view = render(<CoordinatorThread info={info} onRef={onRef} />, { wrapper });
    await waitFor(() => expect(cards()).toHaveLength(3));
    await waitFor(() => expect(cards()[0]!.textContent).toContain("R-7"));
    // The sub-agent and the run it was registered as are one row, under the reply that started them.
    const reply = screen.getByText(/^Handed off the audit as/).closest("li")!;
    const under = within(reply).getByRole("region", { name: "Work started by this reply" });
    expect(within(under).getAllByTestId("coordinator-run-card")).toHaveLength(1);
    expect(under.textContent).toContain("Audit retry policy");
    expect(screen.getAllByRole("region", { name: "Work started by this reply" })).toHaveLength(1);
    // That reply's hand-off and run-start chips are the row; only the other reply keeps its chip.
    expect(within(reply).queryByTestId("actions-taken")).toBeNull();
    expect(screen.getAllByTestId("actions-taken")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Created · Retry policy" })).toBeTruthy();
    // There is no separate "Mentions" list: the references are chips in the reply's own text.
    expect(screen.queryByLabelText("Mentions")).toBeNull();
    expect(screen.queryByText("Mentions:")).toBeNull();
    expect(Array.from(reply.querySelectorAll(".gc-inline-ref")).map((b) => b.textContent)).toEqual(["R-7", "R-9", "D-4"]);
    // The run that has its row under the reply: its chip lands on that row and stays in the conversation.
    const startedRow = within(under).getByTestId("coordinator-run-card");
    expect(startedRow.getAttribute("data-run-ref")).toBe("R-7");
    fireEvent.click(within(reply).getByRole("button", { name: "Run R 7" }));
    expect(startedRow.hasAttribute("data-landed")).toBe(true);
    expect(onRef).not.toHaveBeenCalled();
    // A reference with no row on screen opens its tab instead.
    fireEvent.click(within(reply).getByRole("button", { name: "Run R 9" }));
    fireEvent.click(within(reply).getByRole("button", { name: "Decision D 4" }));
    expect(onRef.mock.calls).toEqual([["R-9"], ["D-4"]]);
    // This thread has no host that draws rows for what a reply mentions: the started work is the only row there.
    expect(screen.queryByRole("region", { name: "Mentioned in this reply" })).toBeNull();
    // What is still going from before the messages, and what has no reply yet, is listed after them.
    const live = screen.getByRole("region", { name: "Work in progress" });
    expect(
      within(live)
        .getAllByTestId("coordinator-run-card")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["Long crawl", "Fresh job"]);
    expect(screen.getByRole("list", { name: "Latest messages" }).compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("list", { name: "Latest messages" }).contains(live)).toBe(false);
    // What ended before the messages on screen is not drawn here (it is in Activity).
    expect(screen.queryByText("Old audit")).toBeNull();
    expect(screen.queryByText("Background work")).toBeNull();
    expect(screen.queryByRole("link", { name: /\bmore$/ })).toBeNull();
    view.unmount();
    // The same reply with no row under it keeps its action chips, and its R-7 opens the run's tab.
    qc.clear();
    records = [];
    onRef.mockClear();
    render(<CoordinatorThread info={info} onRef={onRef} />, { wrapper });
    await waitFor(() => expect(screen.getAllByTestId("actions-taken")).toHaveLength(2));
    expect(screen.queryByTestId("coordinator-run-card")).toBeNull();
    expect(screen.getByRole("button", { name: "Handed off to 1 agent, started 1 run" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run R 7" }));
    expect(onRef).toHaveBeenCalledExactlyOnceWith("R-7");
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
  it("lists only direct earlier discussions and New forces creation instead of reusing the old session", async () => {
    conversations = [
      { id: "s1", title: "Current", placement: { parentId: "wk_area" } },
      { id: "nested", title: "Nested conversation", placement: { parentId: "wk_project" } },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `old${i}`, title: `Earlier ${i}`, placement: { parentId: "wk_area" } })),
    ];
    render(<CoordinatorThread info={info} />, { wrapper });
    const disclosure = screen.getByText("Earlier threads", { exact: true }).closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("/api/work/conversations?"));
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    await screen.findByRole("button", { name: "Earlier 0" });
    expect(api.get).toHaveBeenCalledWith("/api/work/conversations?view=all&areaId=wk_area");
    // PR A: earlier threads open in the panel (buttons, never /chat links); direct children only, never the current one.
    expect(within(within(disclosure).getByRole("list", { name: "Earlier threads" })).getAllByRole("button")).toHaveLength(7);
    expect(within(disclosure).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Nested conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Current" })).toBeNull();
    // New thread asks first; nothing is created until the first message.
    fireEvent.click(within(disclosure).getByRole("button", { name: "New thread" }));
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
