// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent } from "@/lib/cw-runs";
import { scopeMessage, type ComposeScope } from "@/lib/coordinator/compose";
import type { BackgroundWork } from "@/lib/coordinator/run-card";
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
let onCompose = vi.fn<(scope: ComposeScope) => void>();
let onStop = vi.fn<(run: CoordinatorRunRow) => void | Promise<unknown>>();
function mount(runs: CoordinatorRunRow[], initialRef?: string, lastLooked = markers, events: RunEvent[] = []) {
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs, events, lastLooked });
  return render(
    <QueryClientProvider client={client}>
      <RunningPanel onCompose={onCompose} onStop={onStop} initialRef={initialRef} />
    </QueryClientProvider>,
  );
}
/**
 * A run's row is three lines and its actions:
 *   line 1  R-n, the state mark, the state word and what is known ("R-3 Stalled · no report for 2 d");
 *   line 2  the title, a link to the item the run is for (`body`: also what j / k move between);
 *   line 3  a one-line peek: what it needs, its latest report, or how it ended;
 *   then the icon actions for its state and "Details for R-n", which opens the row in place.
 */
const article = (ref: string) => document.querySelector<HTMLElement>(`[data-run-ref="${ref}"]`)!;
const row = (ref: string) => within(article(ref));
const body = (ref: string) => document.querySelector<HTMLElement>(`[data-run-body="${ref}"]`)!;
const details = (ref: string) => row(ref).getByRole("button", { name: `Details for ${ref}` });
const expanded = (ref: string) => details(ref).getAttribute("aria-expanded");
const word = (ref: string) => article(ref).querySelector(".rc-state")!.textContent;
/** Line 1 after the R-n: the state word and its detail. */
const line = (ref: string) => {
  const first = article(ref).querySelector(".k-thing-eyebrow")!.textContent ?? "";
  expect(first.startsWith(ref)).toBe(true);
  return first.slice(ref.length);
};
/** Line 3, or null when the row has nothing to add. */
const peek = (ref: string) => article(ref).querySelector(".k-thing-main > .k-thing-s")?.textContent ?? null;
/** The row's own controls, in order (not those of a sub-run drawn inside it). */
const controls = (ref: string) => Array.from(article(ref).querySelector(".k-thing-acts")!.querySelectorAll("button")).map((b) => b.textContent);
const order = () => Array.from(document.querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"));
/** Nothing but the "looked" marker was posted: no run, steer or stop request left the panel. */
const onlyLooked = () => vi.mocked(api.post).mock.calls.every(([path]) => path === "/api/coordinator/looked");
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  onCompose = vi.fn();
  onStop = vi.fn();
  vi.spyOn(api, "get").mockResolvedValue({ events: [] });
  vi.spyOn(api, "post").mockResolvedValue({ lastLooked: { ...markers, running: at } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
it("groups runs as Needs you, Working, Done; under Needs you: waiting, then failed and stalled by need, then interrupted", async () => {
  mount(
    [
      run(1),
      run(2, { state: "waiting" }),
      run(3, { state: "failed" }),
      run(4, { state: "interrupted" }),
      run(5, { state: "done", finishedAt: at }),
      run(6, { stalled: true }),
      run(7, { state: "waiting", updatedAt: earlier }),
    ],
    undefined,
    { ...markers, running: earlier },
  );
  expect(order()).toEqual(["R-2", "R-7", "R-3", "R-6", "R-4", "R-1", "R-5"]);
  await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/coordinator/looked", { surface: "running" }));
  // Three sections, in this order, each marked for the catch-up chips to land on.
  expect(Array.from(document.querySelectorAll("[data-land]")).map((s) => [s.getAttribute("data-land"), s.getAttribute("aria-label")])).toEqual([
    ["needs", "Needs you"],
    ["working", "Working"],
    ["done", "Done since you looked"],
  ]);
  const refs = (name: string) => Array.from(screen.getByRole("region", { name }).querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"));
  expect(refs("Needs you")).toEqual(["R-2", "R-7", "R-3", "R-6", "R-4"]);
  expect(refs("Working")).toEqual(["R-1"]);
  expect(refs("Done since you looked")).toEqual(["R-5"]);
  expect(within(screen.getByRole("region", { name: "Needs you" })).getByRole("heading").textContent).toBe("Needs you5");
  // Each row says its state in one of the five shared words.
  expect(["R-2", "R-3", "R-6", "R-4", "R-1", "R-5"].map(word)).toEqual(["Needs you", "Failed", "Stalled", "Stalled", "Working", "Done"]);
  expect(line("R-4")).toMatch(/^Stalled · interrupted /);
  expect(line("R-6")).toMatch(/^Stalled · no report for /);
  // A new failure or stall is announced once, in the same words.
  expect(screen.getByRole("status").textContent).toBe("R-3 failed. R-6 stalled");
});
it("only the run that most needs the owner arrives open; every other row opens from its Details button", () => {
  mount([
    run(1),
    run(2, { state: "waiting" }),
    run(3, { state: "failed" }),
    run(4, { state: "interrupted" }),
    run(5, { state: "waiting", updatedAt: earlier }),
  ]);
  const open = () => Object.fromEntries(order().map((ref) => [ref, expanded(ref!)]));
  expect(open()).toEqual({ "R-2": "true", "R-5": "false", "R-3": "false", "R-4": "false", "R-1": "false" });
  expect(article("R-2").hasAttribute("data-open")).toBe(true);
  // an open row's button points at what it opened
  expect(document.getElementById(details("R-2").getAttribute("aria-controls")!)?.closest("article")).toBe(article("R-2"));
  expect(details("R-3").hasAttribute("aria-controls")).toBe(false);
  fireEvent.click(details("R-3"));
  fireEvent.click(details("R-2"));
  expect(open()).toEqual({ "R-2": "false", "R-5": "false", "R-3": "true", "R-4": "false", "R-1": "false" });
  // The title is not the toggle: it is a link to the item the run is for, and carries no expanded state.
  expect(body("R-3").tagName).toBe("A");
  expect(body("R-3").getAttribute("href")).toBe("/areas?item=item");
  expect(body("R-3").textContent).toBe("Work 3");
  expect(body("R-3").hasAttribute("aria-expanded")).toBe(false);
  fireEvent.click(body("R-3"));
  expect(expanded("R-3")).toBe("true");
  // With nothing that needs the owner, nothing arrives open.
  cleanup();
  mount([run(1), run(2, { state: "done", finishedAt: new Date().toISOString() })]);
  expect(open()).toEqual({ "R-1": "false", "R-2": "false" });
});
it("among stalled runs a reported failed step outranks silence alone, and that row is the one that arrives open", () => {
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
  expect(order()).toEqual(["R-2", "R-1"]);
  expect(expanded("R-2")).toBe("true");
  expect(expanded("R-1")).toBe("false");
  // A failed step is not a failed run: the word stays Stalled and the detail leads with the failure. Line three
  // is what it last reported, and the event under it carries the "Step failed" chip.
  expect(line("R-2")).toBe("Stalled · a step failed · no report for 1 h");
  expect(peek("R-2")).toBe("Re-run of the coupon test: failed again");
  expect(article("R-2").getAttribute("data-state")).toBe("stuck");
  expect(row("R-2").getAllByText("Step failed")).toHaveLength(1);
  expect(within(row("R-2").getByRole("list", { name: "Events for R-2" })).getByText("Re-run of the coupon test: failed again")).toBeTruthy();
  // Silence alone is "Stalled" with how long, not a claim that anything failed.
  expect(line("R-1")).toBe("Stalled · no report for 31 min");
  expect(peek("R-1")).toBe("Building");
});
it("Stop asks once on the row: Cancel sends nothing, confirming calls onStop once, and no run API is called from here", async () => {
  mount([run(65)]);
  // Stop is on the row of a working run, next to Steer; there is no "⋯" button.
  expect(row("R-65").getByRole("button", { name: "Steer R-65" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  const stop = row("R-65").getByRole("button", { name: "Stop R-65", expanded: false });
  fireEvent.click(stop);
  expect(onStop).not.toHaveBeenCalled();
  expect(stop.getAttribute("aria-expanded")).toBe("true");
  const confirm = () => screen.getByRole("group", { name: "Stop R-65 and its sub-agents?" });
  // The confirmation says what the second tap does.
  expect(confirm().textContent).toContain("Stop R-65 and its sub-agents? The request goes to the Chief of staff as soon as you confirm.");
  fireEvent.click(within(confirm()).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group")).toBeNull();
  expect(onStop).not.toHaveBeenCalled();
  // Tapping the row's Stop a second time also closes it without stopping anything.
  fireEvent.click(stop);
  fireEvent.click(stop);
  expect(screen.queryByRole("group")).toBeNull();
  expect(onStop).not.toHaveBeenCalled();
  fireEvent.click(stop);
  fireEvent.click(within(confirm()).getByRole("button", { name: "Stop R-65" }));
  expect(onStop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "run-65", ref: "R-65", title: "Work 65" }));
  // Once the request is away the confirmation closes.
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  expect(onCompose).not.toHaveBeenCalled();
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(onlyLooked()).toBe(true);
});
it("a stop that could not be sent keeps its confirmation open, so it can be tried again", async () => {
  onStop.mockRejectedValueOnce(new Error("Offline"));
  mount([run(65)]);
  fireEvent.click(row("R-65").getByRole("button", { name: "Stop R-65" }));
  const confirm = () =>
    within(screen.getByRole("group", { name: "Stop R-65 and its sub-agents?" })).getByRole("button", { name: "Stop R-65" }) as HTMLButtonElement;
  fireEvent.click(confirm());
  await waitFor(() => expect(confirm().disabled).toBe(false));
  expect(onStop).toHaveBeenCalledTimes(1);
  fireEvent.click(confirm());
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  expect(onStop).toHaveBeenCalledTimes(2);
});
it("a stop confirmation belongs to one run: asking to stop another moves it, and confirming stops only that one", async () => {
  mount([run(1), run(2)]);
  fireEvent.click(row("R-1").getByRole("button", { name: "Stop R-1" }));
  expect(screen.getByRole("group", { name: "Stop R-1 and its sub-agents?" })).toBeTruthy();
  fireEvent.click(row("R-2").getByRole("button", { name: "Stop R-2" }));
  expect(screen.queryByRole("group", { name: "Stop R-1 and its sub-agents?" })).toBeNull();
  fireEvent.click(within(screen.getByRole("group", { name: "Stop R-2 and its sub-agents?" })).getByRole("button", { name: "Stop R-2" }));
  expect(onStop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ref: "R-2" }));
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
});
it("Resume all sits in the Needs you header, asks first, then the server resumes every interrupted run (nothing goes to the composer)", async () => {
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
  const needs = within(screen.getByRole("region", { name: "Needs you" }));
  fireEvent.click(needs.getByRole("button", { name: "Resume all 2" }));
  // Nothing is sent before the owner confirms; Cancel sends nothing.
  expect(post.mock.calls.some(([path]) => path === "/api/coordinator/runs/resume")).toBe(false);
  fireEvent.click(within(needs.getByRole("group", { name: "Resume 2 interrupted runs?" })).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Resume 2 interrupted runs?" })).toBeNull();
  fireEvent.click(needs.getByRole("button", { name: "Resume all 2" }));
  fireEvent.click(within(needs.getByRole("group", { name: "Resume 2 interrupted runs?" })).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/coordinator/runs/resume", { refs: ["R-2", "R-1"], confirm: true }));
  expect(await screen.findByText("Resume sent for R-2. Couldn't resume R-1", { selector: "p" })).toBeTruthy();
  expect(onCompose).not.toHaveBeenCalled();
  expect(onStop).not.toHaveBeenCalled();
});
it("offers Resume all only while something is interrupted", () => {
  mount([run(1, { state: "failed" }), run(3, { state: "waiting" })]);
  expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Resume all/ })).toBeNull();
});
it("sub-runs are hidden until expanded, and logs load lazily", async () => {
  const child = run(2, { parentRunId: "run-1", parentRef: "R-1", state: "failed" });
  mount([run(1, { prUrl: "https://example.com/pr/1" }), child]);
  expect(screen.queryByText("R-2")).toBeNull();
  // The closed row still says there is one.
  expect(line("R-1")).toContain("1 sub-run");
  expect(api.get).not.toHaveBeenCalled();
  // Details opens the row in place; only then is its log fetched.
  fireEvent.click(details("R-1"));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/coordinator/runs/R-1/events", expect.anything()));
  expect(screen.getByRole("region", { name: "Sub-runs of R-1" }).textContent).toContain("R-2");
  expect(screen.getByRole("link", { name: /^Pull request/ }).getAttribute("href")).toBe("https://example.com/pr/1");
  expect(api.get).toHaveBeenCalledTimes(1);
});
it("keyboard: j/k move between rows, o opens the details, s puts the run in the composer, x asks to stop and r asks to retry", () => {
  mount([run(1), run(2, { state: "failed" }), run(3, { state: "waiting" })]);
  const panel = screen.getByLabelText("Runs");
  const focused = () => document.activeElement?.getAttribute("data-run-body");
  const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });
  panel.focus();
  fireEvent.keyDown(panel, { key: "j" });
  // What waits on the owner is first, and arrives open. Focus is on its title, the link to its item.
  expect(focused()).toBe("R-3");
  expect(document.activeElement?.tagName).toBe("A");
  expect(expanded("R-3")).toBe("true");
  // o closes and reopens the details of the focused row; focus stays on the row.
  key("o");
  expect(expanded("R-3")).toBe("false");
  key("o");
  expect(expanded("R-3")).toBe("true");
  expect(focused()).toBe("R-3");
  // Enter is left to the link (it opens the item): the panel does not use it, and it toggles nothing.
  expect(key("Enter")).toBe(true);
  expect(expanded("R-3")).toBe("true");
  // s on a run that waits is a reply; nothing is sent, the composer gets the run.
  key("s");
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "reply", ref: "R-3", title: "Work 3" });
  // r on a waiting run resumes it (through the composer too).
  key("r");
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "retry", ref: "R-3", title: "Work 3", verb: "Resume" });
  key("x");
  expect(screen.getByRole("group", { name: "Stop R-3 and its sub-agents?" })).toBeTruthy();
  expect(onStop).not.toHaveBeenCalled();
  key("j");
  expect(focused()).toBe("R-2");
  // A failed run cannot be steered or stopped: s asks about it, x opens no confirmation for it, r retries.
  key("s");
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "ask", ref: "R-2", title: "Work 2" });
  key("x");
  expect(screen.queryByRole("group", { name: "Stop R-2 and its sub-agents?" })).toBeNull();
  key("r");
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "retry", ref: "R-2", title: "Work 2", verb: "Retry" });
  key("j");
  expect(focused()).toBe("R-1");
  key("s");
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "steer", ref: "R-1", title: "Work 1" });
  // A working run has nothing to retry.
  key("r");
  expect(onCompose).toHaveBeenCalledTimes(5);
  key("k");
  key("k");
  expect(focused()).toBe("R-3");
  // The keys asked; none of them sent or stopped anything.
  expect(onStop).not.toHaveBeenCalled();
  expect(onlyLooked()).toBe(true);
});
it("x opens the stop confirmation for the focused run: Cancel does not stop it, confirming calls onStop once", async () => {
  mount([run(1), run(2, { state: "done", finishedAt: new Date().toISOString() })]);
  const panel = screen.getByLabelText("Runs");
  panel.focus();
  fireEvent.keyDown(panel, { key: "j" });
  expect(document.activeElement).toBe(body("R-1"));
  fireEvent.keyDown(body("R-1"), { key: "x" });
  const confirm = () => within(screen.getByRole("group", { name: "Stop R-1 and its sub-agents?" }));
  fireEvent.click(confirm().getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group")).toBeNull();
  expect(onStop).not.toHaveBeenCalled();
  fireEvent.keyDown(body("R-1"), { key: "x" });
  // Opening the confirmation is not the stop: only its button is.
  expect(onStop).not.toHaveBeenCalled();
  fireEvent.click(confirm().getByRole("button", { name: "Stop R-1" }));
  expect(onStop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ref: "R-1" }));
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  // A run that has finished has nothing to stop: x does nothing on it.
  fireEvent.keyDown(body("R-2"), { key: "x" });
  expect(screen.queryByRole("group")).toBeNull();
  expect(onStop).toHaveBeenCalledTimes(1);
});
it("initialRef reveals a selected sub-run and unsafe PR URLs are not links", async () => {
  mount([run(1, { prUrl: "javascript:alert(1)" }), run(2, { parentRunId: "run-1", parentRef: "R-1" })], "R-2");
  await waitFor(() => expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-2"));
  expect(screen.queryByRole("link", { name: /Pull request/ })).toBeNull();
});
it("renders pipeline and lock; a stalled row does not pulse, a working one does", () => {
  mount([
    run(1, {
      stalled: true,
      lock: { name: "deploy", mode: "holds" },
      pipeline: [
        { stage: "build", state: "ok" },
        { stage: "ci", state: "running" },
      ],
      noticeCount: 3,
    }),
    run(2),
  ]);
  expect(screen.getByRole("img", { name: "Pipeline: build ok, ci running" })).toBeTruthy();
  expect(screen.getByText("Holds deploy lock")).toBeTruthy();
  expect(article("R-1").hasAttribute("data-live")).toBe(false);
  expect(article("R-1").querySelector(".rc-shimmer")).toBeNull();
  expect(article("R-2").hasAttribute("data-live")).toBe(true);
  expect(article("R-2").querySelector(".rc-shimmer")?.textContent).toBe("Working");
});
it("renders the empty state", () => {
  mount([]);
  expect(screen.getByText("Nothing running")).toBeTruthy();
});
it("a row is three lines: its R-n and state, its title as a link to the item, and a peek; then the actions for its state", () => {
  mount([run(1, { summary: "Work 1" }), run(2, { state: "failed", summary: "Tests failed on the ledger import" }), run(3, { stalled: true, summary: null })]);
  // Line one is not interactive: the R-n, the state mark, the state word and what is known.
  const first = article("R-1").querySelector<HTMLElement>(".k-thing-eyebrow")!;
  expect(within(first).getByRole("img", { name: "Run R 1" })).toBeTruthy();
  expect(first.textContent).toBe("R-1Working · updated 2 h ago");
  expect(first.querySelector("a, button")).toBeNull();
  // Line two is the title: a link to the item the run is for, not a toggle.
  expect(row("R-1").getByRole("link", { name: "Work 1" })).toBe(body("R-1"));
  expect(body("R-1").getAttribute("href")).toBe("/areas?item=item");
  // Line three is left out when there is nothing to add: a summary that only repeats the title is not shown.
  expect(peek("R-1")).toBeNull();
  // Working: Steer and Stop, right on the closed row, then Details. There is no "⋯" button and no text field.
  expect(controls("R-1")).toEqual(["Steer R-1", "Stop R-1", "Details for R-1"]);
  expect(row("R-1").queryByRole("button", { name: "Actions for R-1" })).toBeNull();
  expect(row("R-1").queryByRole("textbox")).toBeNull();
  fireEvent.click(details("R-1"));
  expect(row("R-1").queryByText("Work 1", { selector: ".rc-summary" })).toBeNull();
  // Opened, it says who is on it.
  expect(row("R-1").getByText("devchief")).toBeTruthy();
  // What needs the owner arrives open. Failed: how it ended is the peek; Retry, and it cannot be stopped.
  expect(line("R-2")).toBe("Failed · 2 h ago");
  expect(peek("R-2")).toBe("Tests failed on the ledger import");
  expect(controls("R-2")).toEqual(["Retry R-2", "Details for R-2"]);
  expect(row("R-2").queryByRole("button", { name: "Stop R-2" })).toBeNull();
  fireEvent.click(details("R-2"));
  expect(expanded("R-2")).toBe("false");
  expect(article("R-2").hasAttribute("data-open")).toBe(false);
  // Stalled: it may still be running, so Steer and Stop.
  expect(line("R-3")).toBe("Stalled · no report for 2 h");
  expect(controls("R-3")).toEqual(["Steer R-3", "Stop R-3", "Details for R-3"]);
  expect(screen.getByRole("region", { name: "Needs you" }).textContent).toContain("R-2");
  // The old "Log" icon is gone everywhere: Details is the one way to open a row.
  expect(screen.queryByRole("button", { name: /^Log for/ })).toBeNull();
});
it("actions by state: interrupted resumes, done only has Details, waiting without a decision is answered or stopped", () => {
  mount([
    run(1, { state: "interrupted" }),
    run(2, { state: "done", finishedAt: new Date().toISOString(), summary: "Shipped the ledger import" }),
    run(3, { state: "waiting" }),
  ]);
  expect(controls("R-3")).toEqual(["Reply to R-3", "Stop R-3", "Details for R-3"]);
  expect(controls("R-1")).toEqual(["Resume R-1", "Details for R-1"]);
  expect(controls("R-2")).toEqual(["Details for R-2"]);
  fireEvent.click(row("R-1").getByRole("button", { name: "Resume R-1" }));
  expect(onCompose).toHaveBeenCalledExactlyOnceWith({ kind: "retry", ref: "R-1", title: "Work 1", verb: "Resume" });
  // A finished run is the same three-line row as any other, not a one-line form: state, title, how it ended.
  expect(article("R-2").querySelector("[data-tight]")).toBeNull();
  expect(line("R-2")).toBe("Done · just now");
  expect(body("R-2").getAttribute("href")).toBe("/areas?item=item");
  expect(peek("R-2")).toBe("Shipped the ledger import");
  expect(expanded("R-2")).toBe("false");
  fireEvent.click(details("R-2"));
  expect(expanded("R-2")).toBe("true");
});
it("a run with no item has a plain title: there is nothing for it to link to", () => {
  mount([run(1, { itemId: "" })]);
  expect(body("R-1").tagName).toBe("SPAN");
  expect(body("R-1").textContent).toBe("Work 1");
  expect(row("R-1").queryByRole("link")).toBeNull();
  expect(controls("R-1")).toEqual(["Steer R-1", "Stop R-1", "Details for R-1"]);
});
it("Steer, Retry and Ask in chat put the run in the one composer; nothing is typed in the row and nothing is sent", async () => {
  mount([run(1), run(2, { state: "failed" })]);
  fireEvent.click(row("R-1").getByRole("button", { name: "Steer R-1" }));
  expect(onCompose).toHaveBeenCalledExactlyOnceWith({ kind: "steer", ref: "R-1", title: "Work 1" });
  // No field opens in the row, closed or open.
  fireEvent.click(details("R-1"));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  fireEvent.click(row("R-1").getByRole("button", { name: "Ask in chat about R-1" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "ask", ref: "R-1", title: "Work 1" });
  // A failed run cannot be steered: its row offers Retry, and a question in chat once open.
  expect(row("R-2").queryByRole("button", { name: "Steer R-2" })).toBeNull();
  fireEvent.click(row("R-2").getByRole("button", { name: "Retry R-2" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "retry", ref: "R-2", title: "Work 2", verb: "Retry" });
  fireEvent.click(row("R-2").getByRole("button", { name: "Ask in chat about R-2" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "ask", ref: "R-2", title: "Work 2" });
  expect(onCompose).toHaveBeenCalledTimes(4);
  expect(onStop).not.toHaveBeenCalled();
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(onlyLooked()).toBe(true);
});
it("a run waiting on the owner arrives open, says what it needs and jumps to its decision; replying goes to the composer", () => {
  const onRef = vi.fn();
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
        onCompose={onCompose}
        onStop={onStop}
        onRef={onRef}
        decisions={[
          { id: "d1", ref: "D-9", itemId: "item", runId: "run-4", question: "Which frame should I order?", state: "open", createdAt: at } as Decision,
        ]}
      />
    </QueryClientProvider>,
  );
  expect(expanded("R-4")).toBe("true");
  expect(expanded("R-1")).toBe("false");
  // Needs you always names what it waits for: the decision, when there is one, and its question as the peek.
  expect(line("R-4")).toBe("Needs you · answer D-9 · for 2 h");
  expect(peek("R-4")).toBe("Which frame should I order?");
  expect(article("R-4").querySelector(".rc-ask-text")!.textContent).toBe("Needs youWhich frame should I order?");
  // The row's one action is the decision chip: it opens the decision, it does not answer it.
  expect(controls("R-4")).toEqual(["D-9", "Details for R-4"]);
  fireEvent.click(row("R-4").getByRole("button", { name: "Decision D 9" }));
  expect(onRef).toHaveBeenCalledExactlyOnceWith("D-9");
  // Everything else is in the open row. Replying in the owner's own words and resuming go to the composer.
  expect(row("R-4").queryByRole("textbox")).toBeNull();
  fireEvent.click(row("R-4").getByRole("button", { name: "Reply to R-4 in your own words" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "reply", ref: "R-4", title: "Work 4" });
  fireEvent.click(row("R-4").getByRole("button", { name: "Resume R-4 without replying" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "retry", ref: "R-4", title: "Work 4", verb: "Resume" });
  fireEvent.click(row("R-4").getByRole("button", { name: "Stop R-4" }));
  expect(screen.getByRole("group", { name: "Stop R-4 and its sub-agents?" })).toBeTruthy();
  expect(onStop).not.toHaveBeenCalled();
  // No decision raised: the agent's own waiting summary is the ask, on the closed row too; Reply and Stop are on it.
  expect(expanded("R-5")).toBe("false");
  expect(line("R-5")).toBe("Needs you · for 12 h");
  expect(peek("R-5")).toBe("Pick a frame before I order samples");
  expect(controls("R-5")).toEqual(["Reply to R-5", "Stop R-5", "Details for R-5"]);
  expect(row("R-5").queryByRole("button", { name: /^Decision/ })).toBeNull();
  fireEvent.click(row("R-5").getByRole("button", { name: "Reply to R-5" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "reply", ref: "R-5", title: "Work 5" });
  fireEvent.click(details("R-5"));
  expect(article("R-5").querySelector(".rc-ask-text")!.textContent).toBe("Needs youPick a frame before I order samples");
});
it("only the newest event of a working run pulses, and only while it is news; the row gives its age and what it last said", () => {
  const event = (id: string, minutes: number): RunEvent =>
    ({ id, runId: "run-1", type: "progress", at: new Date(Date.now() - minutes * 60_000).toISOString(), summary: `Did ${id}`, payload: {} }) as RunEvent;
  const old = event("old", 17);
  const view = mount([run(1, { lastEvent: old })], undefined, markers, [old]);
  expect(line("R-1")).toBe("Working · last report 17 min ago");
  expect(peek("R-1")).toBe("Did old");
  fireEvent.click(details("R-1"));
  expect(article("R-1").querySelectorAll(".rc-event")).toHaveLength(1);
  expect(article("R-1").querySelector(".rc-event[data-live]")).toBeNull();
  view.unmount();
  const fresh = event("fresh", 0.5);
  mount([run(1, { lastEvent: fresh })], undefined, markers, [fresh]);
  expect(line("R-1")).toBe("Working · last report just now");
  expect(peek("R-1")).toBe("Did fresh");
  fireEvent.click(details("R-1"));
  expect(article("R-1").querySelector(".rc-event[data-live]")).toBeTruthy();
});
it("the newest event stops pulsing once it is no longer news, on a row that stays on screen", () => {
  vi.useFakeTimers();
  try {
    const event = (id: string, minutes: number): RunEvent =>
      ({ id, runId: "run-1", type: "progress", at: new Date(Date.now() - minutes * 60_000).toISOString(), summary: `Did ${id}`, payload: {} }) as RunEvent;
    const older = event("older", 9);
    const newest = event("newest", 0.5);
    mount([run(1, { lastEvent: newest })], undefined, markers, [older, newest]);
    fireEvent.click(details("R-1"));
    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-run-ref="R-1"] .rc-event')];
    // both events are listed, and only the first (newest) one pulses
    expect(rows().length).toBeGreaterThanOrEqual(2);
    expect(rows().map((r) => r.hasAttribute("data-live"))).toEqual([
      true,
      ...rows()
        .slice(1)
        .map(() => false),
    ]);
    // the clock ticks past two minutes with nothing new reported: the same row stops pulsing
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(rows().some((r) => r.hasAttribute("data-live"))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("right-click or long-press opens a menu with every action for that run's state; none of them sends", () => {
  mount([run(1), run(2, { state: "failed", prUrl: "https://example.com/pr/2" }), run(3, { state: "waiting" })]);
  const items = (ref: string) => {
    fireEvent.contextMenu(article(ref), { clientX: 30, clientY: 40 });
    const menu = screen.getByRole("menu", { name: `Actions for ${ref}` });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    return { menu, labels };
  };
  // The menu is reached by right-click, long press or the Menu key only: no row carries a "⋯" button.
  expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  // working: steer, ask, log, item, copy, stop. The menu is headed by the run and its state.
  let m = items("R-1");
  expect(m.menu.querySelector(".k-menu-h")?.textContent).toBe("R-1 · Working");
  expect(m.labels).toEqual(["Steer…", "Ask in chat", "Open log", "Open item", "Copy R-1", "Stop…"]);
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Steer…" }));
  // it handed the run to the composer; no field opened in the row
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "steer", ref: "R-1", title: "Work 1" });
  expect(row("R-1").queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  m = items("R-1");
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Open log" }));
  expect(expanded("R-1")).toBe("true");
  expect(items("R-1").labels).toContain("Close log");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  // failed: retry, its pull request, no steer and no stop
  m = items("R-2");
  expect(m.labels).toEqual(["Retry", "Ask in chat", "Open log", "Open item", "Open pull request", "Copy R-2"]);
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Retry" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "retry", ref: "R-2", title: "Work 2", verb: "Retry" });
  // waiting: Reply leads; resuming without an answer is still possible, and says what it is
  m = items("R-3");
  expect(m.menu.querySelector(".k-menu-h")?.textContent).toBe("R-3 · Needs you");
  expect(m.labels).toEqual(["Reply…", "Resume without replying", "Ask in chat", "Close log", "Open item", "Copy R-3", "Stop…"]);
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Resume without replying" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "retry", ref: "R-3", title: "Work 3", verb: "Resume" });
  m = items("R-3");
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Reply…" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "reply", ref: "R-3", title: "Work 3" });
  m = items("R-3");
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Ask in chat" }));
  expect(onCompose).toHaveBeenLastCalledWith({ kind: "ask", ref: "R-3", title: "Work 3" });
  // Stop from the menu opens the same confirmation as the row's Stop; it stops nothing by itself.
  m = items("R-3");
  fireEvent.click(within(m.menu).getByRole("menuitem", { name: "Stop…" }));
  expect(screen.getByRole("group", { name: "Stop R-3 and its sub-agents?" })).toBeTruthy();
  expect(onStop).not.toHaveBeenCalled();
  expect(onlyLooked()).toBe(true);
});
it("an open row says how many steps a run has reported", () => {
  mount([run(1, { noticeCount: 3 }), run(2, { noticeCount: 1 }), run(3)]);
  for (const ref of ["R-1", "R-2", "R-3"]) fireEvent.click(details(ref));
  expect(row("R-1").getByText("3 steps reported")).toBeTruthy();
  expect(row("R-2").getByText("1 step reported")).toBeTruthy();
  expect(row("R-3").queryByText(/reported$/)).toBeNull();
});
it("Done lists the three most recent, with the rest behind Show all; a deep-linked one is never folded away", () => {
  const done = [1, 2, 3, 4, 5].map((n) => run(n, { state: "done", finishedAt: at }));
  const view = mount(done, undefined, { ...markers, running: earlier });
  const section = () => screen.getByRole("region", { name: "Done since you looked" });
  expect(order()).toEqual(["R-5", "R-4", "R-3"]);
  // The header still counts all of them.
  expect(within(section()).getByRole("heading").textContent).toBe("Done since you looked5");
  const all = within(section()).getByRole("button", { name: "Show all" });
  expect(all.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(all);
  expect(order()).toEqual(["R-5", "R-4", "R-3", "R-2", "R-1"]);
  fireEvent.click(within(section()).getByRole("button", { name: "Show fewer", expanded: true }));
  expect(order()).toEqual(["R-5", "R-4", "R-3"]);
  view.unmount();
  mount(done, "R-1", { ...markers, running: earlier });
  expect(order()).toEqual(["R-5", "R-4", "R-3", "R-2", "R-1"]);
  cleanup();
  // Three or fewer: nothing to fold, no button.
  mount(done.slice(0, 3), undefined, { ...markers, running: earlier });
  expect(within(section()).queryByRole("button", { name: /^Show/ })).toBeNull();
});
it("says how fresh the list is only when a refresh failed, with Retry on the same line", async () => {
  mount([run(1)]);
  // A healthy sync says nothing.
  expect(document.querySelector(".rc-live")).toBeNull();
  expect(screen.queryByText(/Synced/)).toBeNull();
  // (marking the visit cancels a refresh in flight: let it settle before the list refreshes)
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(document.querySelector(".rc-live")).toBeNull();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/api/coordinator/runs") throw new Error("Offline");
    return { events: [] };
  });
  await act(async () => {
    await client.refetchQueries({ queryKey: COORDINATOR_RUNS_KEY, exact: true });
  });
  await waitFor(() => expect(document.querySelector(".rc-live")).toBeTruthy());
  const sync = document.querySelector<HTMLElement>(".rc-live")!;
  expect(sync.getAttribute("data-state")).toBe("failed");
  expect(sync.textContent).toContain("Couldn't refresh · last synced just now");
  // What was on screen stays on screen.
  expect(article("R-1")).toBeTruthy();
  vi.mocked(api.get).mockImplementation(async (path: string) =>
    path === "/api/coordinator/runs" ? { runs: [run(1)], events: [], lastLooked: markers } : { events: [] },
  );
  fireEvent.click(within(sync).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(document.querySelector(".rc-live")).toBeNull());
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
/** One background-work row on its own, with spies for its two ways out: a command sent now, or a chip in the composer. */
function exec(work: BackgroundWork, props: { pending?: boolean; events?: RunEvent[] } = {}) {
  const onControl = vi.fn<(input: string) => Promise<unknown>>().mockResolvedValue(undefined);
  const onScope = vi.fn<(scope: ComposeScope) => void>();
  const ui = (w: BackgroundWork) => <ExecCard work={w} pending={props.pending ?? false} events={props.events} onControl={onControl} onCompose={onScope} />;
  const view = render(ui(work));
  return { onControl, onScope, show: (w: BackgroundWork) => view.rerender(ui(w)), unmount: view.unmount };
}
const execCard = () => screen.getByTestId("coordinator-run-card");
const execActions = () => Array.from(execCard().querySelectorAll(".k-thing-acts button")).map((b) => b.textContent);
/** The same three lines as a run's row: the R-n (when it is a tracked run) and state, the title, a one-line peek. */
const execLine = () => execCard().querySelector(".k-thing-eyebrow")!.textContent;
const execTitle = () => execCard().querySelector<HTMLElement>(".k-thing-title")!;
const execPeek = () => execCard().querySelector(".k-thing-main > .k-thing-s")?.textContent ?? null;
const execState = () => execCard().querySelector(".rc-state")!.textContent;
it("background work is the same three-line row: its state in the shared words, its title, the step it is on; Steer and Stop for a sub-agent that can take them", () => {
  const view = exec({ record: sub({ step: "Reading the feeds", startedAt: at }) });
  expect(execCard().className).toContain("rc-row");
  expect(execCard().getAttribute("data-state")).toBe("running");
  // not a tracked run: no R-n on line one, and nothing for a reference chip to land on
  expect(execLine()).toBe("Working · 2 hours ago");
  expect(execCard().hasAttribute("data-run-ref")).toBe(false);
  // it has no conversation of its own to open: the title is plain text
  expect(execTitle().tagName).toBe("SPAN");
  expect(execTitle().textContent).toBe("Audit the feeds");
  expect(execPeek()).toBe("Reading the feeds");
  // the row already says all there is: no Details button, no "⋯", no text field
  expect(execActions()).toEqual(["Steer Audit the feeds", "Stop Audit the feeds"]);
  expect(screen.queryByRole("button", { name: /^(Details|Log|Actions) for/ })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  // Steer hands the sub-agent to the composer, addressed by its own handle; nothing is sent.
  fireEvent.click(screen.getByRole("button", { name: "Steer Audit the feeds" }));
  expect(view.onScope).toHaveBeenCalledExactlyOnceWith({ kind: "steer", ref: undefined, title: "Audit the feeds", handle: "sa_1" });
  expect(scopeMessage(view.onScope.mock.calls[0]![0], "Only the feeds page")).toBe("Steer sa_1: Only the feeds page");
  expect(view.onControl).not.toHaveBeenCalled();
  // While a command is being sent the row's actions wait.
  view.unmount();
  exec({ record: sub() }, { pending: true });
  expect((screen.getByRole("button", { name: "Steer Audit the feeds" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Stop Audit the feeds" }) as HTMLButtonElement).disabled).toBe(true);
});
it("background work with a conversation of its own: the title is the link to it, and Details appears only when there is more to show", () => {
  const view = exec({ record: sub({ href: "/chat/child", summary: "Half way" }) });
  const toggle = (name: string) => screen.queryByRole("button", { name: `Details for ${name}` });
  // the title opens the work itself; there is no separate "Open" link
  expect(screen.getByRole("link", { name: "Audit the feeds" })).toBe(execTitle());
  expect(execTitle().getAttribute("href")).toBe("/chat/child");
  expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  expect(execPeek()).toBe("Half way");
  expect(toggle("Audit the feeds")).toBeNull();
  // links it reported: something more, behind Details
  view.show({ record: sub({ href: "/chat/child", links: [{ url: "https://example.com/pr/1", label: "PR 1", kind: "github" }] }) });
  expect(toggle("Audit the feeds")!.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /^PR 1/ })).toBeNull();
  fireEvent.click(toggle("Audit the feeds")!);
  expect(toggle("Audit the feeds")!.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(toggle("Audit the feeds")!.getAttribute("aria-controls")!)).toBeTruthy();
  expect(screen.getByRole("link", { name: /^PR 1/ }).getAttribute("href")).toBe("https://example.com/pr/1");
  expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  // progress it reports while it is going
  view.show({ record: sub({ progress: 0.4 }) });
  expect(screen.getByRole("progressbar", { name: "40% done" })).toBeTruthy();
  view.show({ record: sub() });
  expect(toggle("Audit the feeds")).toBeNull();
  view.unmount();
  // a tracked run: its R-n leads line one and names the Details button, and its latest reports are the detail
  const report = { id: "e1", runId: "run-7", runRef: "R-7", type: "progress", summary: "Checked 4 of 9 feeds", payload: {}, via: null, at } as RunEvent;
  exec({ record: sub(), control: sub(), run: run(7) }, { events: [report] });
  expect(execLine()).toBe("R-7Working · updated 2 h ago");
  expect(execCard().getAttribute("data-run-ref")).toBe("R-7");
  expect(execActions()).toEqual(["Steer R-7", "Stop R-7", "Details for R-7"]);
  fireEvent.click(toggle("R-7")!);
  expect(within(screen.getByRole("list", { name: "Latest events for R-7" })).getByText("Checked 4 of 9 feeds")).toBeTruthy();
});
it("background work says Stalled after 30 minutes without a report, Needs you when it waits, and nothing it does not know", () => {
  const silent = new Date(Date.now() - 45 * 60_000).toISOString();
  const view = exec({ record: sub({ updatedAt: silent }) });
  expect(execState()).toBe("Stalled");
  expect(execCard().getAttribute("data-state")).toBe("stuck");
  expect(execLine()).toBe("Stalled · no report for 45 min");
  // a record that only says when it started is not evidence of a stall
  view.show({ record: sub({ startedAt: earlier }) });
  expect(execState()).toBe("Working");
  expect(execCard().hasAttribute("data-live")).toBe(true);
  // what it waits for is the peek; it is answered through the composer
  view.show({ record: sub({ state: "waiting", summary: "Which feed first?" }) });
  expect(execState()).toBe("Needs you");
  expect(execPeek()).toBe("Which feed first?");
  fireEvent.click(screen.getByRole("button", { name: "Reply to Audit the feeds" }));
  expect(view.onScope).toHaveBeenLastCalledWith({ kind: "reply", ref: undefined, title: "Audit the feeds", handle: "sa_1" });
  view.show({ record: sub({ state: "completed", summary: "Audited 9 feeds" }) });
  expect(execState()).toBe("Done");
  // a finished row is the same shape as any other: how it ended is its third line
  expect(execCard().querySelector("[data-tight]")).toBeNull();
  expect(execPeek()).toBe("Audited 9 feeds");
  expect(execActions()).toEqual([]);
  view.show({ record: sub({ state: "cancelled" }) });
  expect(execState()).toBe("Stopped");
  view.show({ record: sub({ state: "failed", error: "(no summary — status=failed: vendor portal timed out)" }) });
  expect(execState()).toBe("Failed");
  expect(execPeek()).toBe("Vendor portal timed out");
  // nothing is known yet: that is not "Working"
  view.show({ record: sub({ state: "unknown" }) });
  expect(execState()).toBe("No report yet");
  expect(execCard().querySelector(".k-sw")).toBeNull();
  expect(execCard().hasAttribute("data-live")).toBe(false);
  expect(execPeek()).toBe("Started · hasn't reported yet.");
  expect(execActions()).toEqual([]);
});
it("work that failed arrives with its details open and can be answered; finished work arrives closed", () => {
  const view = exec({ record: sub({ state: "failed", error: "Timed out", links: [{ url: "https://example.com/log", label: "Log", kind: "web" }] }) });
  const toggle = () => screen.getByRole("button", { name: "Details for Audit the feeds" });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(execCard().querySelector(".rc-outcome")!.textContent).toBe("ErrorTimed out");
  // it cannot be steered or stopped any more, only answered: an ordinary line about it
  expect(execActions()).toEqual(["Reply to Audit the feeds", "Details for Audit the feeds"]);
  fireEvent.click(screen.getByRole("button", { name: "Reply to Audit the feeds" }));
  expect(view.onScope).toHaveBeenCalledExactlyOnceWith({ kind: "ask", ref: undefined, title: "Audit the feeds" });
  expect(scopeMessage(view.onScope.mock.calls[0]![0], "Use the posted amount")).toBe('About "Audit the feeds": Use the posted amount');
  expect(view.onControl).not.toHaveBeenCalled();
  view.unmount();
  exec({ record: sub({ state: "completed", links: [{ url: "https://example.com/log", label: "Log", kind: "web" }] }) });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});
it("background work: a long press offers what the row can do, and work with nothing to offer keeps the browser's menu", async () => {
  const view = exec({ record: sub({ href: "/chat/child", links: [{ url: "https://example.com/pr/1", label: "PR 1", kind: "github" }] }) });
  fireEvent.contextMenu(execCard(), { clientX: 20, clientY: 20 });
  expect(screen.getByRole("menu", { name: "Actions for Audit the feeds" })).toBeTruthy();
  expect(menuLabels()).toEqual(["Steer…", "Open conversation", "Open PR 1", "Stop…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Stop…" }));
  expect(screen.queryByRole("menu")).toBeNull();
  // the same confirmation as the row's Stop: nothing is sent by the menu itself
  expect(view.onControl).not.toHaveBeenCalled();
  const confirm = screen.getByRole("group", { name: "Stop Audit the feeds?" });
  expect(confirm.textContent).toContain("Stop this sub-agent? The request goes to the coordinator as soon as you confirm.");
  fireEvent.click(within(confirm).getByRole("button", { name: "Stop sub-agent" }));
  await waitFor(() => expect(view.onControl).toHaveBeenCalledExactlyOnceWith("Stop sa_1"));
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  expect(view.onScope).not.toHaveBeenCalled();
  view.unmount();
  exec({ record: sub({ state: "completed" }) });
  const untouched = fireEvent.contextMenu(execCard(), { clientX: 20, clientY: 20 });
  expect(untouched).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});
it("a sub-agent's stop is confirmed in place: Cancel sends nothing, and a request that failed keeps the confirmation open", async () => {
  const view = exec({ record: sub(), control: sub() });
  const stop = screen.getByRole("button", { name: "Stop Audit the feeds" });
  fireEvent.click(stop);
  expect(stop.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(screen.getByRole("group", { name: "Stop Audit the feeds?" })).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group")).toBeNull();
  expect(view.onControl).not.toHaveBeenCalled();
  view.onControl.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(stop);
  fireEvent.click(screen.getByRole("button", { name: "Stop sub-agent" }));
  await waitFor(() => expect(view.onControl).toHaveBeenCalledTimes(1));
  // still open: the owner can try again
  expect(screen.getByRole("group", { name: "Stop Audit the feeds?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop sub-agent" }));
  await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
  expect(view.onControl.mock.calls).toEqual([["Stop sa_1"], ["Stop sa_1"]]);
});
it("a sub-agent still going after its tracked run ended keeps Steer and Stop on its row, and both go to the sub-agent", async () => {
  const view = exec({ record: sub(), control: sub(), run: run(7, { state: "done", finishedAt: at }) });
  // the row shows the run's state, says a sub-agent is still going, and keeps its controls in view
  expect(execCard().querySelector(".rc-state")!.textContent).toBe("Done");
  expect(execCard().getAttribute("data-state")).toBe("done");
  expect(execLine()).toBe("R-7Done · 2 h ago · a sub-agent is still working");
  expect(execActions()).toEqual(["Steer sub-agent of R-7", "Stop sub-agent of R-7"]);
  fireEvent.contextMenu(execCard(), { clientX: 20, clientY: 20 });
  expect(screen.getByRole("menu").querySelector(".k-menu-h")?.textContent).toBe("R-7 · Done");
  expect(menuLabels()).toEqual(["Steer sub-agent…", "Copy R-7", "Stop sub-agent…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Stop sub-agent…" }));
  // the run has ended: there is nothing of it to stop, and the request names the sub-agent
  expect(screen.getByRole("group", { name: "Stop Audit the feeds?" }).textContent).toContain("Stop this sub-agent?");
  fireEvent.click(screen.getByRole("button", { name: "Stop sub-agent" }));
  await waitFor(() => expect(view.onControl).toHaveBeenCalledExactlyOnceWith("Stop sa_1"));
  expect(view.onScope).not.toHaveBeenCalled();
  fireEvent.contextMenu(execCard(), { clientX: 20, clientY: 20 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Steer sub-agent…" }));
  // steering goes to the sub-agent's own handle, not to the run that tracked it
  const scope = view.onScope.mock.calls[0]![0];
  expect(scope).toEqual({ kind: "steer", ref: "R-7", title: "Audit the feeds", handle: "sa_1" });
  expect(scopeMessage(scope, "Wrap up")).toBe("Steer sa_1: Wrap up");
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("a finished run takes no Steer, and a sub-agent that has ended is not steered through a run that is still going", async () => {
  const panel = mount([run(1, { state: "done", finishedAt: at })]);
  fireEvent.contextMenu(article("R-1"), { clientX: 30, clientY: 40 });
  // a run that has ended only offers a question in chat
  expect(menuLabels()).not.toContain("Steer…");
  expect(menuLabels()).not.toContain("Stop…");
  expect(menuLabels()).toContain("Ask in chat");
  expect(row("R-1").queryByRole("button", { name: "Steer R-1" })).toBeNull();
  panel.unmount();
  const view = exec({ record: sub({ state: "completed" }), control: sub({ state: "completed" }), run: run(7) });
  // the row shows the run (still working), but the only sub-agent it could reach has finished: no Steer
  expect(execCard().querySelector(".rc-state")!.textContent).toBe("Working");
  expect(execActions()).toEqual(["Stop R-7"]);
  expect(execCard().textContent).not.toContain("a sub-agent is still working");
  fireEvent.contextMenu(execCard(), { clientX: 20, clientY: 20 });
  expect(menuLabels()).toEqual(["Copy R-7", "Stop…"]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  // the run itself can still be stopped: confirmed once, then the request for the run and its sub-agents is sent
  fireEvent.click(screen.getByRole("button", { name: "Stop R-7" }));
  expect(view.onControl).not.toHaveBeenCalled();
  const confirm = screen.getByRole("group", { name: "Stop Audit the feeds?" });
  expect(confirm.textContent).toContain("Stop R-7 and its sub-agents? The request goes to the coordinator as soon as you confirm.");
  fireEvent.click(within(confirm).getByRole("button", { name: "Stop R-7" }));
  await waitFor(() => expect(view.onControl).toHaveBeenCalledExactlyOnceWith("Stop R-7 (Audit the feeds) and its sub-agents."));
  expect(view.onScope).not.toHaveBeenCalled();
});
it("a stop confirmation closes when what it would do changes: stopping a run never becomes stopping a sub-agent, or another run", () => {
  const view = exec({ record: sub(), control: sub(), run: run(7) });
  const asked = () => screen.queryByRole("group", { name: /^Stop / });
  fireEvent.click(screen.getByRole("button", { name: "Stop R-7" }));
  expect(within(asked()!).getByRole("button", { name: "Stop R-7" })).toBeTruthy();
  // the next poll: the run is no longer this row's, so stopping would now go straight to the sub-agent
  view.show({ record: sub(), control: sub() });
  expect(asked()).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop sub-agent" })).toBeNull();
  // and it stays closed when the run comes back: it does not reopen without being asked
  view.show({ record: sub(), control: sub(), run: run(7) });
  expect(asked()).toBeNull();
  // a confirmation opened for one run does not carry over to another
  fireEvent.click(screen.getByRole("button", { name: "Stop R-7" }));
  expect(asked()!.textContent).toContain("Stop R-7 and its sub-agents?");
  view.show({ record: sub(), control: sub(), run: run(8) });
  expect(asked()).toBeNull();
  // nor to the same run once it has ended (the sub-agent lingers: stopping would now reach it alone)
  view.show({ record: sub(), control: sub(), run: run(7) });
  fireEvent.click(screen.getByRole("button", { name: "Stop R-7" }));
  view.show({ record: sub(), control: sub(), run: run(7, { state: "done", finishedAt: at }) });
  expect(asked()).toBeNull();
  // asking again says what it will do now, and only then does it
  view.show({ record: sub(), control: sub() });
  fireEvent.click(screen.getByRole("button", { name: "Stop Audit the feeds" }));
  expect(within(asked()!).getByRole("button", { name: "Stop sub-agent" })).toBeTruthy();
  expect(view.onControl).not.toHaveBeenCalled();
  expect(view.onScope).not.toHaveBeenCalled();
});
it("a stop can never reach a different sub-agent than the row shows", async () => {
  const other = sub({ key: "subagent:sa_2", id: "sa_2", subagentId: "sa_2" });
  const view = exec({ record: sub(), control: sub() });
  const asked = () => screen.queryByRole("group", { name: /^Stop / });
  fireEvent.click(screen.getByRole("button", { name: "Stop Audit the feeds" }));
  expect(asked()).toBeTruthy();
  // the same row comes to control another sub-agent (a new source, a reorder): the open confirmation is not for it
  view.show({ record: sub(), control: other });
  expect(asked()).toBeNull();
  expect(view.onControl).not.toHaveBeenCalled();
  // asked again, it stops the one the row now controls, and only that one
  fireEvent.click(screen.getByRole("button", { name: "Stop Audit the feeds" }));
  fireEvent.click(within(asked()!).getByRole("button", { name: "Stop sub-agent" }));
  await waitFor(() => expect(view.onControl).toHaveBeenCalledExactlyOnceWith("Stop sa_2"));
  await waitFor(() => expect(asked()).toBeNull());
  // a sub-agent that ends while its stop is being confirmed leaves nothing to confirm, and nothing to send
  view.show({ record: sub(), control: sub() });
  fireEvent.click(screen.getByRole("button", { name: "Stop Audit the feeds" }));
  expect(asked()).toBeTruthy();
  view.show({ record: sub({ state: "completed" }), control: sub({ state: "completed" }) });
  expect(asked()).toBeNull();
  expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  // a child found through the session list is addressed by Hermes' own handle, never by its session id
  view.show({ record: sub({ id: "child_session_9", subagentId: "sa_9" }) });
  fireEvent.click(screen.getByRole("button", { name: "Stop Audit the feeds" }));
  fireEvent.click(within(asked()!).getByRole("button", { name: "Stop sub-agent" }));
  await waitFor(() => expect(view.onControl).toHaveBeenLastCalledWith("Stop sa_9"));
  expect(view.onControl).toHaveBeenCalledTimes(2);
});
it("work that cannot be reached offers no Steer or Stop: a registered run, a job, an unsafe handle", () => {
  const view = exec({ record: sub({ source: "registered_run", key: "registered_run:reg_1", id: "reg_1", subagentId: null }) });
  const controls = () => screen.queryAllByRole("button", { name: /^(Steer|Stop)/ });
  expect(controls()).toEqual([]);
  view.show({ record: sub({ id: "bad id", subagentId: null }) });
  expect(controls()).toEqual([]);
  view.show({ record: sub({ source: "jarvis_run", key: "jarvis_run:job_1", id: "job_1", subagentId: null, state: "waiting" }) });
  expect(controls()).toEqual([]);
  // it can still be answered, as an ordinary line about it
  fireEvent.click(screen.getByRole("button", { name: "Reply to Audit the feeds" }));
  expect(view.onScope).toHaveBeenCalledExactlyOnceWith({ kind: "reply", ref: undefined, title: "Audit the feeds" });
  expect(view.onControl).not.toHaveBeenCalled();
});
it("shows no timeline on a closed row and a real one on an open row", async () => {
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
  const list = () => within(row("R-1").getByRole("list", { name: "Events for R-1" })).getAllByRole("listitem");
  // Closed: no list of events, only the newest thing it said as the peek.
  expect(row("R-1").queryByRole("list", { name: "Events for R-1" })).toBeNull();
  expect(peek("R-1")).toBe("Ran out of budget");
  fireEvent.click(details("R-1"));
  expect(row("R-1").getByText("devchief")).toBeTruthy();
  // Open: the three newest events that say something; the rest (and the bare "Started") are one tap away.
  expect(list()).toHaveLength(3);
  expect(list()[0]!.textContent).toContain("FailedRan out of budget");
  // When it reported, start to now.
  expect(row("R-1").getByRole("img", { name: /^5 reports since it started; the last one / })).toBeTruthy();
  fireEvent.click(row("R-1").getByRole("button", { name: "Show 2 earlier" }));
  expect(list()).toHaveLength(5);
  // The "started" event only repeats the title: it keeps its chip and drops the words.
  expect(list().at(-1)!.textContent).toMatch(/^Started/);
  expect(list().at(-1)!.textContent).not.toContain("Work 1");
  expect(list()[3]!.querySelector(".k-t-ok")).toBeTruthy();
});
it("folds failures older than three days away from what needs the owner now, still one tap away", () => {
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  mount([run(1, { state: "failed" }), run(2, { state: "failed", updatedAt: old }), run(3, { state: "failed", updatedAt: old })]);
  expect(screen.getByRole("region", { name: "Needs you" }).querySelectorAll("article").length).toBe(1);
  const older = screen.getByRole("region", { name: "Older failures" });
  expect(older.querySelectorAll("article").length).toBe(0);
  // Folded, it names what is in there.
  expect(older.textContent).toContain("Work 3 · Work 2");
  fireEvent.click(within(older).getByRole("button", { name: "Show" }));
  expect(Array.from(older.querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"))).toEqual(["R-3", "R-2"]);
  // History does not arrive open.
  expect(expanded("R-3")).toBe("false");
});
it("a deep-linked old failure is shown in place, not hidden in the fold", () => {
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  mount([run(2, { state: "failed", updatedAt: old })], "R-2");
  expect(screen.getByRole("region", { name: "Needs you" }).textContent).toContain("R-2");
  expect(screen.queryByRole("region", { name: "Older failures" })).toBeNull();
});
it("uses one quiet line instead of the empty state when other activity is listed below", () => {
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs: [], events: [], lastLooked: markers });
  render(
    <QueryClientProvider client={client}>
      <RunningPanel onCompose={onCompose} onStop={onStop} quietEmpty />
    </QueryClientProvider>,
  );
  expect(screen.getByText("No agent runs right now.")).toBeTruthy();
  expect(screen.queryByText("Nothing running")).toBeNull();
});
it("keeps the 24-hour done window throughout a first visit with no prior marker", async () => {
  mount([run(1, { state: "done", finishedAt: new Date().toISOString() })]);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(screen.getByRole("region", { name: "Done since you looked" }).textContent).toContain("R-1");
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
  // a run the reply mentions, with no row of its own under it, is a chip too
  expect(screen.getByRole("button", { name: "Run R 65" })).toBeTruthy();
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
it("the catch-up chips use the shared words: runs that need you and runs that stalled", () => {
  client.setQueryData(["session", "thread"], {
    session: { id: "thread" },
    timeline: [{ kind: "assistant", id: "new", at: new Date(Date.now() - 30 * 60_000).toISOString(), text: "Two things moved." }],
  });
  const onJump = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CoordinatorThread
        info={info}
        lastLookedChat={new Date(Date.now() - 2 * 3_600_000).toISOString()}
        sinceCounts={{ decisions: 0, runs: 4, waiting: 2, stuck: 1, finished: 1 }}
        onJump={onJump}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "2 need you" }));
  fireEvent.click(screen.getByRole("button", { name: "1 stalled" }));
  expect(screen.getByRole("button", { name: "1 finished" })).toBeTruthy();
  expect(onJump.mock.calls).toEqual([
    ["running", "waiting"],
    ["running", "stuck"],
  ]);
});
it("a steer started on a background-work row stays addressed to its sub-agent when a tracked run arrives and when the rows reorder", async () => {
  client.setQueryData(["session", "thread"], { session: { id: "thread" }, timeline: [{ kind: "assistant", id: "reply", at, text: "Working" }] });
  const a = sub({ startedAt: at });
  const b = sub({ key: "subagent:sa_2", id: "sa_2", subagentId: "sa_2", startedAt: at });
  const registration = sub({ key: "registered_run:reg_1", source: "registered_run", id: "reg_1", subagentId: null, state: "unknown" });
  const records = (list: ExecutionRecord[]) =>
    client.setQueryData(["session-exec", "thread"], { sessionId: "thread", parent: null, records: list, sources: [] });
  const tracked = (runs: CoordinatorRunRow[]) => client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs, events: [], lastLooked: markers });
  records([a, registration]);
  tracked([]);
  render(
    <QueryClientProvider client={client}>
      <CoordinatorThread info={info} />
    </QueryClientProvider>,
  );
  const cards = () => screen.getAllByTestId("coordinator-run-card");
  const field = () => screen.getByRole("textbox", { name: "Message the coordinator" }) as HTMLTextAreaElement;
  const chip = () => screen.getByTestId("gc-scope");
  expect(cards()).toHaveLength(1);
  // the one text field is the composer: Steer puts the sub-agent's chip in it and sends nothing
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Steer Audit the feeds" }));
  expect(chip().textContent).toContain("Audit the feeds");
  expect(field().placeholder).toBe("Steer this work…");
  fireEvent.change(field(), { target: { value: "Only the feeds page" } });
  expect(api.post).not.toHaveBeenCalled();
  // its tracked run is matched a poll later: the same row, now with its R-n, and the chip and the text are still there
  act(() => {
    tracked([run(7, { title: "Audit the feeds" })]);
  });
  await waitFor(() => expect(cards()[0]!.textContent).toContain("R-7"));
  expect(cards()).toHaveLength(1);
  expect(field().value).toBe("Only the feeds page");
  expect(chip().getAttribute("aria-label")).toBe("Steering Audit the feeds");
  // a second live sub-agent with the same title turns up and sorts first (it is waiting)
  act(() => {
    records([{ ...b, state: "waiting" }, a, registration]);
  });
  await waitFor(() => expect(cards()).toHaveLength(3));
  expect(field().value).toBe("Only the feeds page");
  // and what was typed for the first one is sent to the first one, through the control channel
  fireEvent.click(screen.getByTestId("coordinator-send"));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/api/hermes/sessions/thread/runs",
      expect.objectContaining({ input: "Steer sa_1: Only the feeds page", idempotencyKey: expect.stringMatching(/^ctl-/) }),
    ),
  );
  expect(vi.mocked(api.post).mock.calls.some(([, payload]) => String((payload as { input?: string } | undefined)?.input).includes("sa_2"))).toBe(false);
  // sent: the field and the chip clear
  await waitFor(() => expect(screen.queryByTestId("gc-scope")).toBeNull());
  expect(field().value).toBe("");
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
