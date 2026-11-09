// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";
import type { CoordinatorRunRow, RunsResponse } from "@/lib/coordinator/runs-view";
import { RunningPanel } from "./RunningPanel";
import { COORDINATOR_RUNS_KEY, useMarkLooked } from "./useCoordinatorRuns";
import { CoordinatorThread, type CoordinatorResponse } from "../CoordinatorThread";

vi.mock("next/navigation", () => ({ usePathname: () => "/areas", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/quick-actions/useQuickActions", () => ({ useQuickActions: () => ({ data: { actions: [] } }) }));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({ QuickActionChips: () => null }));
vi.mock("@/components/quick-actions/ProposedQuickActions", () => ({ ProposedQuickActions: () => null }));
vi.mock("@/components/feedback/RateMessage", () => ({ RateMessage: () => null }));
const at = "2026-11-08T20:10:00Z";
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
let onSteer = vi.fn<(ref: string, title: string) => void>();
function mount(runs: CoordinatorRunRow[], initialRef?: string, lastLooked = markers) {
  client.setQueryData<RunsResponse>(COORDINATOR_RUNS_KEY, { runs, events: [], lastLooked });
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
it("groups attention first, failure first, then interrupted, running, done", async () => {
  const { container } = mount(
    [run(1), run(2, { state: "waiting" }), run(3, { state: "failed" }), run(4, { state: "interrupted" }), run(5, { state: "done", finishedAt: at })],
    undefined,
    { ...markers, running: "2026-11-08T10:00:00Z" },
  );
  expect(Array.from(container.querySelectorAll("article")).map((r) => r.getAttribute("data-run-ref"))).toEqual(["R-3", "R-2", "R-4", "R-1", "R-5"]);
  await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/coordinator/looked", { surface: "running" }));
  expect(screen.getByRole("region", { name: "Done since you looked" }).textContent).toContain("R-5");
});
it("Stop requires confirmation; cancel and confirm only prefill, never call a run API", async () => {
  mount([run(65)]);
  fireEvent.click(screen.getByRole("button", { name: "Stop R-65" }));
  expect(onCommand).not.toHaveBeenCalled();
  const confirm = screen.getByRole("group", { name: "Stop R-65 and its sub-agents?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop R-65" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith("Stop R-65 (Work 65) and its sub-agents.");
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(vi.mocked(api.post).mock.calls.every(([path]) => path === "/api/coordinator/looked")).toBe(true);
});
it("Resume all builds a single interrupted command", () => {
  mount([run(1, { state: "interrupted" }), run(2, { state: "interrupted" }), run(3, { state: "waiting" })]);
  fireEvent.click(screen.getByRole("button", { name: "Resume all 2" }));
  expect(onCommand).toHaveBeenCalledExactlyOnceWith("Resume R-2, R-1 (interrupted when the session ended).");
});
it("sub-runs are hidden until expanded, and logs load lazily", async () => {
  const child = run(2, { parentRunId: "run-1", parentRef: "R-1", state: "failed" });
  mount([run(1, { prUrl: "https://example.com/pr/1" }), child]);
  expect(screen.queryByText("R-2")).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Log R-1" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/coordinator/runs/R-1/events", expect.anything()));
  expect(screen.getByRole("region", { name: "Sub-runs of R-1" }).textContent).toContain("R-2");
  expect(screen.getByRole("link", { name: "Open pull request" }).getAttribute("href")).toBe("https://example.com/pr/1");
  expect(api.get).toHaveBeenCalledTimes(1);
});
it("keyboard j/k focus rows, Enter expands, s steers, x arms stop and r prefills retry/resume", () => {
  mount([run(1), run(2, { state: "failed" }), run(3, { state: "waiting" })]);
  const panel = screen.getByLabelText("Running runs");
  panel.focus();
  fireEvent.keyDown(panel, { key: "j" });
  expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-2");
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(document.activeElement!, { key: "r" });
  expect(onCommand).toHaveBeenLastCalledWith("Retry R-2 (Work 2).");
  fireEvent.keyDown(document.activeElement!, { key: "s" });
  expect(onSteer).toHaveBeenLastCalledWith("R-2", "Work 2");
  fireEvent.keyDown(document.activeElement!, { key: "j" });
  expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-3");
  fireEvent.keyDown(document.activeElement!, { key: "x" });
  expect(screen.getByRole("group", { name: "Stop R-3 and its sub-agents?" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "k" });
  expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-2");
});
it("initialRef reveals a selected sub-run and unsafe PR URLs are not links", async () => {
  mount([run(1, { prUrl: "javascript:alert(1)" }), run(2, { parentRunId: "run-1", parentRef: "R-1" })], "R-2");
  await waitFor(() => expect(document.activeElement?.getAttribute("data-run-body")).toBe("R-2"));
  expect(screen.queryByRole("link", { name: "Open pull request" })).toBeNull();
});
it("renders pipeline, lock, notices, and a non-pulsing stalled state", () => {
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
  expect(screen.getByText("3 notices")).toBeTruthy();
  expect(container.querySelector(".k-dot-live")).toBeNull();
});
it("renders the empty state", () => {
  mount([]);
  expect(screen.getByText("Nothing running")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "2 decisions" }));
  expect(onJump).toHaveBeenCalledWith("needs");
  expect(screen.queryByText(/Hidden background output/)).toBeNull();
  const notices = screen.getByRole("button", { name: "2 background notices" });
  fireEvent.click(notices);
  expect(notices.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByText(/Hidden background output/)).toHaveLength(2);
  fireEvent.click(notices);
  expect(screen.queryByText(/Hidden background output/)).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
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
