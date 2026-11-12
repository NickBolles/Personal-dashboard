// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent } from "@/lib/cw-runs";
import type { CoordinatorRunRow, RunsResponse } from "@/lib/coordinator/runs-view";
import type { ExecutionRecord } from "@/lib/chat-execution";
import { RunningPanel } from "./RunningPanel";
import { ExecCard } from "./RunCard";
import { COORDINATOR_RUNS_KEY, useMarkLooked } from "./useCoordinatorRuns";
import { CoordinatorThread, type CoordinatorResponse } from "../CoordinatorThread";

vi.mock("next/navigation", () => ({ usePathname: () => "/areas", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/quick-actions/useQuickActions", () => ({ useQuickActions: () => ({ data: { actions: [] } }) }));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({ QuickActionChips: () => null }));
vi.mock("@/components/quick-actions/ProposedQuickActions", () => ({ ProposedQuickActions: () => null }));
vi.mock("@/components/feedback/RateMessage", () => ({ RateMessage: () => null }));
// Relative to now: rows older than three days fold under "Older failures".
const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
const earlier = new Date(Date.now() - 12 * 3_600_000).toISOString();
const markers: RunsResponse["lastLooked"] = { chat: null, needs: null, running: null, changes: null, context: null };
function run(seq: number, overrides: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow {
  return {
    id: `run-${seq}`,
    ref: `R-${seq}`,
    seq,
    itemId: "item",
    itemTitle: "Item",
    profile: "devchief",
    title: `Work ${seq}`,
    state: "running",
    stalled: false,
    summary: "Building",
    prUrl: null,
    parentRunId: null,
    parentRef: null,
    pipeline: [],
    lock: null,
    interruptedAt: null,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    noticeCount: 0,
    ...overrides,
  };
}
let client: QueryClient;
let onCommand = vi.fn<(text: string) => void>();
let onSteer = vi.fn<(ref: string, title: string, guidance?: string) => void | Promise<unknown>>();
function mount(runs: CoordinatorRunRow[], initialRef?: string, lastLooked = markers, events: RunEvent[] = []) {
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs, events, lastLooked });
  return render(
    <QueryClientProvider client={client}>
      <RunningPanel onCommand={onCommand} onSteer={onSteer} initialRef={initialRef} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  onCommand = vi.fn();
  onSteer = vi.fn();
  vi.spyOn(api, "get").mockResolvedValue({ events: [] });
  vi.spyOn(api, "post").mockResolvedValue({ lastLooked: { ...markers, running: at } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
it("orders by need: waiting on you, then stuck with failures first, then interrupted, working, finished", async () => {
  const { container } = mount(
    [run(1), run(2, { state: "waiting" }), run(3, { state: "failed" }), run(4, { state: "interrupted" }), run(5, { state: "done", finishedAt: at })],
    undefined,
    { ...markers, running: earlier },
  );
  expect(Array.from(container.querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"))).toEqual(["R-2", "R-3", "R-4", "R-1", "R-5"]);
  await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/coordinator/looked", { surface: "running" }));
  expect(screen.getByRole("region", { name: "Finished since you looked" }).textContent).toContain("R-5");
});
it("among stuck runs a reported failed step outranks silence alone, and that card is the one that arrives open", () => {
  const quietAt = new Date(Date.now() - 31 * 60_000).toISOString();
  const older = new Date(Date.now() - 90 * 60_000).toISOString();
  const failedStep: RunEvent = {
    id: "e1",
    runId: "run-2",
    runRef: "R-2",
    type: "notice",
    summary: "Re-run of the coupon test: failed again",
    payload: {},
    via: null,
    at: older,
  };
  mount([run(1, { stalled: true, updatedAt: quietAt }), run(2, { stalled: true, updatedAt: older })], undefined, markers, [failedStep]);
  expect(Array.from(document.querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"))).toEqual(["R-2", "R-1"]);
  expect(document.querySelector('[data-run-body="R-2"]')!.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[data-run-body="R-1"]')!.getAttribute("aria-expanded")).toBe("false");
  const card = within(document.querySelector<HTMLElement>('[data-run-ref="R-2"]')!);
  // The chip leads with the reported failure; the silence is the detail. The same words label the event below.
  expect(card.getAllByText("Step failed")).toHaveLength(2);
  expect(card.getByText(/^no update for /)).toBeTruthy();
  // Silence alone is "Quiet", not a claim that the run is blocked.
  expect(within(document.querySelector<HTMLElement>('[data-run-ref="R-1"]')!).getByText("Quiet")).toBeTruthy();
});
it("Stop requires confirmation; cancel and confirm only prefill, never call a run API", async () => {
  mount([run(65)]);
  // Stop is one step in: a working run's card is closed until its header is tapped.
  expect(screen.queryByRole("button", { name: "Ask to stop R-65" })).toBeNull();
  fireEvent.click(document.querySelector<HTMLElement>('[data-run-body="R-65"]')!);
  // The button says what it does before it is tapped: it asks, it does not stop.
  expect(screen.getByRole("button", { name: "Ask to stop R-65" }).textContent).toBe("Ask to stop");
  fireEvent.click(screen.getByRole("button", { name: "Ask to stop R-65" }));
  expect(onCommand).not.toHaveBeenCalled();
  const confirm = screen.getByRole("group", { name: "Stop R-65 and its sub-agents?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ask to stop R-65" }));
  // The card says what will happen: a request is written into chat for the owner to send.
  expect(screen.getByRole("group", { name: "Stop R-65 and its sub-agents?" }).textContent).toContain("nothing stops until you send it");
  fireEvent.click(screen.getByRole("button", { name: "Write stop request" }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith("Stop R-65 (Work 65) and its sub-agents.");
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(vi.mocked(api.post).mock.calls.every(([path]) => path === "/api/coordinator/looked")).toBe(true);
});
it("Resume all asks first, then the server resumes every interrupted run (no chat prefill)", async () => {
  mount([run(1, { state: "interrupted" }), run(2, { state: "interrupted" }), run(3, { state: "waiting" })]);
  const post = vi.mocked(api.post);
  post.mockImplementation(async (path: string) =>
    path === "/api/coordinator/runs/resume"
      ? {
          results: [
            { ref: "R-2", ok: true, sent: "run" },
            { ref: "R-1", ok: false, reason: "send_failed" },
          ],
        }
      : { lastLooked: { ...markers, running: at } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume all 2" }));
  // Nothing is sent before the owner confirms; Cancel sends nothing.
  expect(post.mock.calls.some(([path]) => path === "/api/coordinator/runs/resume")).toBe(false);
  fireEvent.click(within(screen.getByRole("group", { name: "Resume 2 interrupted runs?" })).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Resume 2 interrupted runs?" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resume all 2" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Resume 2 interrupted runs?" })).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/coordinator/runs/resume", { refs: ["R-2", "R-1"], confirm: true }));
  expect(await screen.findByText("Resume sent for R-2. Couldn't resume R-1", { selector: "p" })).toBeTruthy();
  expect(onCommand).not.toHaveBeenCalled();
});
it("sub-runs are hidden until expanded, and logs load lazily", async () => {
  const child = run(2, { parentRunId: "run-1", parentRef: "R-1", state: "failed" });
  mount([run(1, { prUrl: "https://example.com/pr/1" }), child]);
  expect(screen.queryByText("R-2")).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
  // The card's header opens it; there is no separate icon to find.
  fireEvent.click(document.querySelector<HTMLElement>('[data-run-body="R-1"]')!);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/coordinator/runs/R-1/events", expect.anything()));
  expect(screen.getByRole("region", { name: "Sub-runs of R-1" }).textContent).toContain("R-2");
  expect(screen.getByRole("link", { name: /^Pull request/ }).getAttribute("href")).toBe("https://example.com/pr/1");
  expect(api.get).toHaveBeenCalledTimes(1);
});
it("keyboard j/k focus rows, Enter expands, s steers, x arms stop and r prefills retry/resume", () => {
  mount([run(1), run(2, { state: "failed" }), run(3, { state: "waiting" })]);
  const panel = screen.getByLabelText("Runs");
  panel.focus();
  fireEvent.keyDown(panel, { key: "j" });
  // What waits on the owner is first, and arrives open; Enter closes and reopens it.
  expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-3");
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "s" });
  expect(onSteer).toHaveBeenLastCalledWith("R-3", "Work 3");
  fireEvent.keyDown(document.activeElement!, { key: "x" });
  expect(screen.getByRole("group", { name: "Stop R-3 and its sub-agents?" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "j" });
  expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-2");
  fireEvent.keyDown(document.activeElement!, { key: "r" });
  expect(onCommand).toHaveBeenLastCalledWith("Retry R-2 (Work 2).");
  fireEvent.keyDown(document.activeElement!, { key: "k" });
  expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-3");
});
it("initialRef reveals a selected sub-run and unsafe PR URLs are not links", async () => {
  mount([run(1, { prUrl: "javascript:alert(1)" }), run(2, { parentRunId: "run-1", parentRef: "R-1" })], "R-2");
  await waitFor(() => expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-2"));
  expect(screen.queryByRole("link", { name: /Pull request/ })).toBeNull();
});
it("renders pipeline, lock and a non-pulsing quiet state", () => {
  const { container } = mount([
    run(1, {
      stalled: true,
      lock: { name: "deploy", mode: "holds" },
      pipeline: [
        { stage: "build", state: "ok" },
        { stage: "ci", state: "running" },
      ],
      noticeCount: 3,
    }),
  ]);
  expect(screen.getByRole("img", { name: "Pipeline: build ok, ci running" })).toBeTruthy();
  expect(screen.getByText("Holds deploy lock")).toBeTruthy();
  expect(container.querySelector("article .k-dot-live")).toBeNull();
});
it("renders the empty state", () => {
  mount([]);
  expect(screen.getByText("Nothing running")).toBeTruthy();
});
it("says what each run is doing in a chip and plain words, and drops a summary that repeats the title", () => {
  mount([run(1, { summary: "Work 1" }), run(2, { state: "failed", summary: "Tests failed on the ledger import" }), run(3, { stalled: true, summary: null })]);
  const row = (ref: string) => within(document.querySelector<HTMLElement>(`[data-run-ref="${ref}"]`)!);
  expect(row("R-1").getByText("Working")).toBeTruthy();
  expect(row("R-1").getByText(/^updated /)).toBeTruthy();
  expect(row("R-1").queryByText("Work 1", { selector: ".rc-summary" })).toBeNull();
  // A working run is closed: its actions are one tap in.
  expect(row("R-1").getAllByRole("button")).toHaveLength(1);
  fireEvent.click(document.querySelector<HTMLElement>('[data-run-body="R-1"]')!);
  expect(row("R-1").getByRole("button", { name: "Steer R-1" }).textContent).toBe("Steer");
  // What needs the owner arrives open, with what it last said and what can be done about it.
  expect(row("R-2").getByText("Failed")).toBeTruthy();
  expect(row("R-2").getByText("Tests failed on the ledger import")).toBeTruthy();
  expect(row("R-2").getByRole("button", { name: "Retry R-2" }).textContent).toBe("Retry");
  expect(row("R-2").queryByRole("button", { name: "Stop R-2" })).toBeNull();
  expect(row("R-3").getByText("Quiet")).toBeTruthy();
  expect(row("R-3").getByText(/^no update for /)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Needs a look" }).textContent).toContain("R-2");
});
it("Steer opens a guidance field in the card and sends what is typed; a stopped run asks in chat instead", async () => {
  onSteer.mockResolvedValue(undefined);
  mount([run(1), run(2, { state: "failed" })]);
  fireEvent.click(document.querySelector<HTMLElement>('[data-run-body="R-1"]')!);
  const card = within(document.querySelector<HTMLElement>('[data-run-ref="R-1"]')!);
  fireEvent.click(card.getByRole("button", { name: "Steer R-1" }));
  expect(onSteer).not.toHaveBeenCalled();
  const field = card.getByRole("textbox", { name: "Guidance for R-1" });
  expect((card.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "Skip the flaky coupon test" } });
  fireEvent.click(card.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onSteer).toHaveBeenCalledExactlyOnceWith("R-1", "Work 1", "Skip the flaky coupon test"));
  await waitFor(() => expect(card.queryByRole("textbox")).toBeNull());
  // A failed run cannot be steered: its card offers Retry and a line in chat.
  const failed = within(document.querySelector<HTMLElement>('[data-run-ref="R-2"]')!);
  expect(failed.queryByRole("button", { name: "Steer R-2" })).toBeNull();
  fireEvent.click(failed.getByRole("button", { name: "Ask in chat about R-2" }));
  expect(onSteer).toHaveBeenLastCalledWith("R-2", "Work 2");
});
it("a run waiting on the owner arrives open, says what it needs, takes a reply, and jumps to its decision", async () => {
  const onRef = vi.fn();
  onSteer.mockResolvedValue(undefined);
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, {
    runs: [
      run(1, { state: "failed" }),
      run(4, { state: "waiting" }),
      run(5, { state: "waiting", summary: "Pick a frame before I order samples", updatedAt: earlier }),
    ],
    events: [],
    lastLooked: markers,
  });
  render(
    <QueryClientProvider client={client}>
      <RunningPanel
        onCommand={onCommand}
        onSteer={onSteer}
        onRef={onRef}
        decisions={[
          { id: "d1", ref: "D-9", itemId: "item", runId: "run-4", question: "Which frame should I order?", state: "open", createdAt: at } as Decision,
        ]}
      />
    </QueryClientProvider>,
  );
  const card = within(document.querySelector<HTMLElement>('[data-run-ref="R-4"]')!);
  expect(document.querySelector('[data-run-body="R-4"]')!.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[data-run-body="R-1"]')!.getAttribute("aria-expanded")).toBe("false");
  expect(card.getByText("Which frame should I order?")).toBeTruthy();
  // The chip says where it goes: it opens the decision, it does not answer it.
  fireEvent.click(card.getByRole("button", { name: "Review decision D 9" }));
  expect(onRef).toHaveBeenCalledExactlyOnceWith("D-9");
  // A waiting run is answered in its card; "Resume" would only confuse the matter.
  expect(card.queryByRole("button", { name: "Resume R-4" })).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Reply to R-4" }));
  fireEvent.change(card.getByRole("textbox", { name: "Reply to R-4" }), { target: { value: "The oak one" } });
  fireEvent.click(card.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onSteer).toHaveBeenCalledExactlyOnceWith("R-4", "Work 4", "The oak one"));
  // No decision raised: the agent's own waiting summary is the ask, on a closed card too.
  const other = within(document.querySelector<HTMLElement>('[data-run-ref="R-5"]')!);
  expect(document.querySelector('[data-run-body="R-5"]')!.getAttribute("aria-expanded")).toBe("false");
  expect(other.getByText("Pick a frame before I order samples")).toBeTruthy();
  expect(other.queryByRole("button", { name: /^Review decision/ })).toBeNull();
});
it("a waiting run's reply button is Resume while the field is empty and Send once there is an answer", () => {
  mount([run(3, { state: "waiting" })]);
  const card = within(document.querySelector<HTMLElement>('[data-run-ref="R-3"]')!);
  fireEvent.click(card.getByRole("button", { name: "Reply to R-3" }));
  // typing swaps the one button to Send; clearing the field swaps it back
  expect(card.queryByRole("button", { name: "Send" })).toBeNull();
  fireEvent.change(card.getByRole("textbox", { name: "Reply to R-3" }), { target: { value: "Keep it under $400" } });
  expect(card.getByRole("button", { name: "Send" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Resume without replying" })).toBeNull();
  fireEvent.change(card.getByRole("textbox", { name: "Reply to R-3" }), { target: { value: "  " } });
  expect(card.getByRole("button", { name: "Resume without replying" }).textContent).toBe("Resume");
  // Enter on an empty field does nothing: resuming is always a deliberate tap
  fireEvent.submit(card.getByRole("textbox", { name: "Reply to R-3" }).closest("form")!);
  expect(onCommand).not.toHaveBeenCalled();
  fireEvent.click(card.getByRole("button", { name: "Resume without replying" }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith("Resume R-3 (Work 3).");
  // the field closes: the choice was made
  expect(card.queryByRole("textbox", { name: "Reply to R-3" })).toBeNull();
});
it("only the newest event of a working run pulses, and only while it is news; the chip gives its age", () => {
  const event = (id: string, minutes: number): RunEvent =>
    ({ id, runId: "run-1", type: "progress", at: new Date(Date.now() - minutes * 60_000).toISOString(), summary: `Did ${id}`, payload: {} }) as RunEvent;
  const old = event("old", 17);
  const view = mount([run(1, { lastEvent: old })], undefined, markers, [old]);
  const card = () => document.querySelector<HTMLElement>('[data-run-ref="R-1"]')!;
  expect(within(card()).getByText("last report 17 min ago")).toBeTruthy();
  expect(card().querySelector(".rc-event[data-live]")).toBeNull();
  view.unmount();
  const fresh = event("fresh", 0.5);
  mount([run(1, { lastEvent: fresh })], undefined, markers, [fresh]);
  expect(within(card()).getByText("last report just now")).toBeTruthy();
  expect(card().querySelector(".rc-event[data-live]")).toBeTruthy();
});
it("the newest event stops pulsing once it is no longer news, on a card that stays on screen", () => {
  vi.useFakeTimers();
  try {
    const event = (id: string, minutes: number): RunEvent =>
      ({ id, runId: "run-1", type: "progress", at: new Date(Date.now() - minutes * 60_000).toISOString(), summary: `Did ${id}`, payload: {} }) as RunEvent;
    const older = event("older", 9);
    const newest = event("newest", 0.5);
    mount([run(1, { lastEvent: newest })], undefined, markers, [older, newest]);
    fireEvent.click(document.querySelector<HTMLElement>('[data-run-body="R-1"]')!);
    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-run-ref="R-1"] .rc-event')];
    // both events are listed, and only the first (newest) one pulses
    expect(rows().length).toBeGreaterThanOrEqual(2);
    expect(rows().map((row) => row.hasAttribute("data-live"))).toEqual([
      true,
      ...rows()
        .slice(1)
        .map(() => false),
    ]);
    // the clock ticks past two minutes with nothing new reported: the same card stops pulsing
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(rows().some((row) => row.hasAttribute("data-live"))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("right-click or long-press opens a menu with every action for that run's state", () => {
  mount([run(1), run(2, { state: "failed", prUrl: "https://example.com/pr/2" }), run(3, { state: "waiting" })]);
  const items = (ref: string) => {
    fireEvent.contextMenu(document.querySelector<HTMLElement>(`[data-run-ref="${ref}"]`)!, { clientX: 30, clientY: 40 });
    const menu = screen.getByRole("menu", { name: `Actions for ${ref}` });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    return { menu, labels };
  };
  // working: steer, ask, open, copy, stop
  let m = items("R-1");
  expect(m.labels).toEqual(["Steer…", "Ask in chat", "Open timeline", "Open item", "Copy R-1", "Ask to stop…"]);
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Steer…" }));
  // it opened the card with the guidance field ready
  expect(within(document.querySelector<HTMLElement>('[data-run-ref="R-1"]')!).getByRole("textbox", { name: "Guidance for R-1" })).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
  // failed: retry, its pull request, no steer and no stop
  m = items("R-2");
  expect(m.labels).toEqual(["Retry", "Ask in chat", "Open timeline", "Open item", "Open pull request", "Copy R-2"]);
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Retry" }));
  expect(onCommand).toHaveBeenLastCalledWith("Retry R-2 (Work 2).");
  // waiting: Reply leads; resuming without an answer is still possible, and says what it is
  m = items("R-3");
  expect(m.labels).toEqual(["Reply…", "Resume without replying", "Ask in chat", "Close timeline", "Open item", "Copy R-3", "Ask to stop…"]);
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Resume without replying" }));
  expect(onCommand).toHaveBeenLastCalledWith("Resume R-3 (Work 3).");
  m = items("R-3");
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Ask to stop…" }));
  expect(screen.getByRole("group", { name: "Stop R-3 and its sub-agents?" })).toBeTruthy();
});
it("says how many steps a run has reported", () => {
  mount([run(1, { noticeCount: 3 }), run(2, { noticeCount: 1 }), run(3)]);
  const card = (ref: string) => within(document.querySelector<HTMLElement>(`[data-run-ref="${ref}"]`)!);
  expect(card("R-1").getByText("3 steps reported")).toBeTruthy();
  expect(card("R-2").getByText("1 step reported")).toBeTruthy();
  expect(card("R-3").queryByText(/reported$/)).toBeNull();
});
const sub = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  key: "subagent:sa_1",
  source: "subagent",
  id: "sa_1",
  subagentId: "sa_1",
  title: "Subagent: Audit the feeds",
  state: "running",
  ...overrides,
});
const menuLabels = () =>
  within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
it("background work: a long press offers what the card can do, and work with nothing to offer keeps the browser's menu", async () => {
  const onControl = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <ExecCard
      work={{ record: sub({ href: "/chat/child", links: [{ url: "https://example.com/pr/1", label: "PR 1", kind: "github" }] }) }}
      pending={false}
      onControl={onControl}
    />,
  );
  fireEvent.contextMenu(screen.getByTestId("coordinator-run-card"), { clientX: 20, clientY: 20 });
  expect(screen.getByRole("menu", { name: "Actions for Audit the feeds" })).toBeTruthy();
  expect(menuLabels()).toEqual(["Steer…", "Open conversation", "Open PR 1", "Ask to stop…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask to stop…" }));
  expect(screen.queryByRole("menu")).toBeNull();
  // the same confirmation as the button: nothing is sent by the menu itself
  expect(onControl).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("group", { name: "Stop Audit the feeds?" })).getByRole("button", { name: "Send stop request" }));
  await waitFor(() => expect(onControl).toHaveBeenCalledExactlyOnceWith("Stop sa_1"));
  view.unmount();
  render(<ExecCard work={{ record: sub({ state: "completed" }) }} pending={false} onControl={onControl} />);
  const untouched = fireEvent.contextMenu(screen.getByTestId("coordinator-run-card"), { clientX: 20, clientY: 20 });
  expect(untouched).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});
it("a sub-agent still going after its tracked run ended keeps Steer and Stop on its card, and its stop goes to the sub-agent", async () => {
  const onControl = vi.fn().mockResolvedValue(undefined);
  const onDraft = vi.fn();
  render(
    <ExecCard
      work={{ record: sub(), control: sub(), run: run(7, { state: "done", finishedAt: at }) }}
      pending={false}
      onControl={onControl}
      onDraft={onDraft}
    />,
  );
  // the card shows the run's state, says a sub-agent is still going, and keeps its controls in view
  expect(screen.getByText("Finished")).toBeTruthy();
  expect(screen.getByText("A sub-agent of this run is still working.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Steer sub-agent" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ask to stop" })).toBeTruthy();
  fireEvent.contextMenu(screen.getByTestId("coordinator-run-card"), { clientX: 20, clientY: 20 });
  expect(menuLabels()).toEqual(["Steer sub-agent…", "Copy R-7", "Ask sub-agent to stop…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask sub-agent to stop…" }));
  fireEvent.click(screen.getByRole("button", { name: "Send stop request" }));
  await waitFor(() => expect(onControl).toHaveBeenCalledExactlyOnceWith("Stop sa_1"));
  expect(onDraft).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByTestId("coordinator-run-card"), { clientX: 20, clientY: 20 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Steer sub-agent…" }));
  expect(screen.getByRole("textbox", { name: "Guidance for Subagent: Audit the feeds" })).toBeTruthy();
});
it("a finished run takes no Steer, and a sub-agent that has ended is not steered through a run that is still going", () => {
  const view = mount([run(1, { state: "done", finishedAt: at })]);
  const card = document.querySelector<HTMLElement>('[data-run-ref="R-1"]')!;
  fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
  // Steer sends from the card, so a run that has ended only offers a line in chat
  expect(menuLabels()).not.toContain("Steer…");
  expect(menuLabels()).toContain("Ask in chat");
  expect(within(card).queryByRole("button", { name: "Steer R-1" })).toBeNull();
  view.unmount();
  const onControl = vi.fn();
  const onDraft = vi.fn();
  render(
    <ExecCard
      work={{ record: sub({ state: "completed" }), control: sub({ state: "completed" }), run: run(7) }}
      pending={false}
      onControl={onControl}
      onDraft={onDraft}
    />,
  );
  // the card shows the run (still working), but the only sub-agent it could reach has finished: no Steer
  expect(screen.queryByRole("button", { name: /^Steer/ })).toBeNull();
  expect(screen.queryByText("A sub-agent of this run is still working.")).toBeNull();
  fireEvent.contextMenu(screen.getByTestId("coordinator-run-card"), { clientX: 20, clientY: 20 });
  expect(menuLabels()).toEqual(["Copy R-7", "Ask to stop…"]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  // the run itself can still be asked to stop, and that only writes the request
  fireEvent.click(screen.getByRole("button", { name: "Ask to stop" }));
  fireEvent.click(screen.getByRole("button", { name: "Write stop request" }));
  expect(onDraft).toHaveBeenCalledExactlyOnceWith("Stop R-7 (Audit the feeds) and its sub-agents.");
  expect(onControl).not.toHaveBeenCalled();
});
it("a stop confirmation closes when what it would do changes: writing a request never becomes sending one", () => {
  const onControl = vi.fn().mockResolvedValue(undefined);
  const onDraft = vi.fn();
  const view = render(<ExecCard work={{ record: sub(), control: sub(), run: run(7) }} pending={false} onControl={onControl} onDraft={onDraft} />);
  fireEvent.click(screen.getByRole("button", { name: "Ask to stop" }));
  expect(screen.getByRole("button", { name: "Write stop request" })).toBeTruthy();
  // the next poll: the run is no longer this card's, so stopping would now go straight to the sub-agent
  view.rerender(<ExecCard work={{ record: sub(), control: sub() }} pending={false} onControl={onControl} onDraft={onDraft} />);
  expect(screen.queryByRole("group", { name: /^Stop / })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send stop request" })).toBeNull();
  // and it stays closed when the run comes back: it does not reopen without being asked
  view.rerender(<ExecCard work={{ record: sub(), control: sub(), run: run(7) }} pending={false} onControl={onControl} onDraft={onDraft} />);
  expect(screen.queryByRole("group", { name: /^Stop / })).toBeNull();
  // a confirmation opened for one run does not carry over to another
  fireEvent.click(screen.getByRole("button", { name: "Ask to stop" }));
  expect(screen.getByText(/stop R-7 and its sub-agents/)).toBeTruthy();
  view.rerender(<ExecCard work={{ record: sub(), control: sub(), run: run(8) }} pending={false} onControl={onControl} onDraft={onDraft} />);
  expect(screen.queryByRole("group", { name: /^Stop / })).toBeNull();
  // asking again says what it will do now, and only then does it
  view.rerender(<ExecCard work={{ record: sub(), control: sub() }} pending={false} onControl={onControl} onDraft={onDraft} />);
  fireEvent.click(screen.getByRole("button", { name: "Ask to stop" }));
  expect(screen.getByRole("button", { name: "Send stop request" })).toBeTruthy();
  expect(onControl).not.toHaveBeenCalled();
  expect(onDraft).not.toHaveBeenCalled();
});
it("shows the latest event on a closed card and a real timeline on an open one", async () => {
  const ev = (n: number, type: RunEvent["type"], summary: string, min: number): RunEvent => ({
    id: `e${n}`,
    runId: "run-1",
    runRef: "R-1",
    type,
    summary,
    payload: {},
    via: null,
    at: new Date(Date.now() - min * 60_000).toISOString(),
  });
  const events = [
    ev(1, "started", "Work 1", 50),
    ev(2, "ci", "Checks passed", 40),
    ev(3, "progress", "Half way", 30),
    ev(4, "notice", "Wrote the report", 20),
    ev(5, "failed", "Ran out of budget", 10),
  ];
  mount([run(1)], undefined, markers, events);
  const card = within(document.querySelector<HTMLElement>('[data-run-ref="R-1"]')!);
  const list = () => within(card.getByRole("list", { name: "Events for R-1" })).getAllByRole("listitem");
  // Closed: just the newest event, as a labelled chip and its words.
  expect(list().map((li) => li.textContent)).toEqual([expect.stringContaining("FailedRan out of budget")]);
  fireEvent.click(document.querySelector<HTMLElement>('[data-run-body="R-1"]')!);
  // Open: the three newest events that say something; the rest (and the bare "Started") are one tap away.
  expect(list()).toHaveLength(3);
  // Who is on it (with the working arc) and when it reported, start to now.
  expect(document.querySelector('[data-run-ref="R-1"] .agent-mark')!.getAttribute("data-busy")).toBe("true");
  expect(card.getByRole("img", { name: /^5 reports since it started; the last one / })).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Show 2 earlier" }));
  expect(list()).toHaveLength(5);
  // The "started" event only repeats the title: it keeps its chip and drops the words.
  expect(list().at(-1)!.textContent).toMatch(/^Started/);
  expect(list().at(-1)!.textContent).not.toContain("Work 1");
  expect(list()[3]!.querySelector(".k-t-ok")).toBeTruthy();
});
it("folds failures older than three days away from what is stuck now, still one tap away", () => {
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  mount([run(1, { state: "failed" }), run(2, { state: "failed", updatedAt: old }), run(3, { state: "failed", updatedAt: old })]);
  expect(screen.getByRole("region", { name: "Needs a look" }).querySelectorAll("article").length).toBe(1);
  const older = screen.getByRole("region", { name: "Older failures" });
  expect(older.querySelectorAll("article").length).toBe(0);
  fireEvent.click(within(older).getByRole("button", { name: "Show" }));
  expect(Array.from(older.querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"))).toEqual(["R-3", "R-2"]);
});
it("a deep-linked old failure is shown in place, not hidden in the fold", () => {
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  mount([run(2, { state: "failed", updatedAt: old })], "R-2");
  expect(screen.getByRole("region", { name: "Needs a look" }).textContent).toContain("R-2");
  expect(screen.queryByRole("region", { name: "Older failures" })).toBeNull();
});
it("uses one quiet line instead of the empty state when other activity is listed below", () => {
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs: [], events: [], lastLooked: markers });
  render(
    <QueryClientProvider client={client}>
      <RunningPanel onCommand={onCommand} onSteer={onSteer} quietEmpty />
    </QueryClientProvider>,
  );
  expect(screen.getByText("No agent runs right now.")).toBeTruthy();
  expect(screen.queryByText("Nothing running")).toBeNull();
});
it("keeps the 24-hour done window throughout a first visit with no prior marker", async () => {
  mount([run(1, { state: "done", finishedAt: new Date().toISOString() })]);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(screen.getByRole("region", { name: "Finished since you looked" }).textContent).toContain("R-1");
});
it("optimistically marks looked and rolls back only that surface on failure", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.post).mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs: [], events: [], lastLooked: { ...markers, chat: at } });
  function Marker() {
    const { mutate } = useMarkLooked();
    return <Button onClick={() => mutate("running")}>Mark</Button>;
  }
  render(
    <QueryClientProvider client={client}>
      <Marker />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Mark"));
  await waitFor(() => expect(client.getQueryData<RunsResponse>(COORDINATOR_RUNS_KEY)?.lastLooked.running).toBeTruthy());
  expect(client.getQueryData<RunsResponse>(COORDINATOR_RUNS_KEY)?.lastLooked.chat).toBe(at);
  reject(new Error("Offline"));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(client.getQueryData<RunsResponse>(COORDINATOR_RUNS_KEY)?.lastLooked.running).toBeNull();
});

const info: CoordinatorResponse = {
  area: { id: "dev", title: "Development" },
  agent: { requested: "devchief", profile: "devchief", routed: true, reason: "routed" },
  sessionId: "thread",
  sessionTitle: "Coordinator",
  excluded: false,
  prompt: null,
  lastRunAt: null,
};
it("thread has one since separator, safe mention chips and folded background notice groups", async () => {
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const newer = new Date(Date.now() - 30 * 60_000).toISOString();
  const frame = "[IMPORTANT: Background process job completed (exit code 0)]\nOutput:\nHidden background output";
  client.setQueryData(["session", "thread"], {
    session: { id: "thread" },
    timeline: [
      { kind: "user", id: "old", at: old, text: "Before" },
      { kind: "assistant", id: "new", at: newer, text: "Review **D-48** and R-65. `D-99`" },
      { kind: "user", id: "notice1", at: newer, text: frame },
      { kind: "system", id: "notice2", at: newer, text: frame },
    ],
  });
  const onRef = vi.fn();
  const onJump = vi.fn();
  const { container } = render(
    <QueryClientProvider client={client}>
      <CoordinatorThread
        info={info}
        lastLookedChat={new Date(Date.now() - 2 * 3_600_000).toISOString()}
        sinceCounts={{ decisions: 2, runs: 1 }}
        onRef={onRef}
        onJump={onJump}
      />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole("separator")).toHaveLength(1);
  expect(container.querySelector("strong")?.textContent).toBe("D-48");
  fireEvent.click(screen.getByRole("button", { name: "Decision D 48" }));
  expect(onRef).toHaveBeenCalledWith("D-48");
  expect(screen.queryByRole("button", { name: "Decision D 99" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2 new decisions" }));
  expect(screen.getByRole("button", { name: "1 run updated" })).toBeTruthy();
  // the chip says which part of the tab it was about, so the tab can land there
  expect(onJump).toHaveBeenCalledWith("needs", "decisions");
  expect(screen.queryByText(/Hidden background output/)).toBeNull();
  const notices = screen.getByRole("button", { name: "2 background notices" });
  fireEvent.click(notices);
  expect(notices.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByText(/Hidden background output/)).toHaveLength(2);
  fireEvent.click(notices);
  expect(screen.queryByText(/Hidden background output/)).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
it("guidance being typed on a background-work card stays with its sub-agent when a tracked run arrives and when the cards reorder", async () => {
  client.setQueryData(["session", "thread"], { session: { id: "thread" }, timeline: [{ kind: "assistant", id: "reply", at, text: "Working" }] });
  const a = sub({ startedAt: at });
  const b = sub({ key: "subagent:sa_2", id: "sa_2", subagentId: "sa_2", startedAt: at });
  const registration = sub({ key: "registered_run:reg_1", source: "registered_run", id: "reg_1", subagentId: null, state: "unknown" });
  const exec = (records: ExecutionRecord[]) => client.setQueryData(["session-exec", "thread"], { sessionId: "thread", parent: null, records, sources: [] });
  const tracked = (runs: CoordinatorRunRow[]) => client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs, events: [], lastLooked: markers });
  exec([a, registration]);
  tracked([]);
  render(
    <QueryClientProvider client={client}>
      <CoordinatorThread info={info} />
    </QueryClientProvider>,
  );
  const cards = () => screen.getAllByTestId("coordinator-run-card");
  expect(cards()).toHaveLength(1);
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Steer" }));
  const field = () => screen.getByRole("textbox", { name: /^Guidance for/ }) as HTMLTextAreaElement;
  fireEvent.change(field(), { target: { value: "Only the feeds page" } });
  // its tracked run is matched a poll later: the same card, now with its R-n, and the text is still there
  act(() => {
    tracked([run(7, { title: "Audit the feeds" })]);
  });
  await waitFor(() => expect(cards()[0]!.textContent).toContain("R-7"));
  expect(cards()).toHaveLength(1);
  expect(field().value).toBe("Only the feeds page");
  // a second live sub-agent with the same title turns up and sorts first (it is waiting)
  act(() => {
    exec([{ ...b, state: "waiting" }, a, registration]);
  });
  await waitFor(() => expect(cards()).toHaveLength(3));
  expect(field().value).toBe("Only the feeds page");
  // and what was typed for the first one is sent to the first one
  fireEvent.click(within(field().closest<HTMLElement>('[data-testid="coordinator-run-card"]')!).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/thread/runs", expect.objectContaining({ input: "Steer sa_1: Only the feeds page" })),
  );
  expect(vi.mocked(api.post).mock.calls.some(([, body]) => String((body as { input?: string } | undefined)?.input).includes("sa_2"))).toBe(false);
});
it("thread omits the divider without a marker; the owner's active-run Stop still stops it", async () => {
  client.setQueryData(["session", "thread"], {
    session: { id: "thread", activeRun: { runId: "active-1" } },
    timeline: [{ kind: "assistant", id: "reply", at, text: "Working" }],
  });
  render(
    <QueryClientProvider client={client}>
      <CoordinatorThread info={info} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("separator")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/runs/active-1/stop"));
});
