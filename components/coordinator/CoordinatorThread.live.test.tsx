// @vitest-environment jsdom
/**
 * The Chief of staff panel shows the run in flight: its text as it is written, its steps, and the approval or
 * question it is waiting on, answerable right there. It reads the run from the shared stream
 * (lib/client/run-streams.ts) and stops polling the conversation while that stream is open.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { LINGER_MS, openRunStreams } from "@/lib/client/run-streams";
import { CoordinatorThread, type CoordinatorResponse } from "./CoordinatorThread";

vi.mock("next/navigation", () => ({ usePathname: () => "/areas", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/client/session-lists", () => ({ refreshSessionLists: vi.fn(async () => undefined) }));
vi.mock("@/components/quick-actions/useQuickActions", () => ({ useQuickActions: () => ({ data: { actions: [] } }) }));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({ QuickActionChips: () => null }));
vi.mock("@/components/quick-actions/ProposedQuickActions", () => ({ ProposedQuickActions: () => null }));
vi.mock("@/components/feedback/RateMessage", () => ({ RateMessage: () => null }));

class FakeSource {
  static all: FakeSource[] = [];
  closed = false;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(event: object, id?: number) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: id === undefined ? "" : String(id) } as MessageEvent);
  }
}
const open = () => FakeSource.all.filter((s) => !s.closed);
const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const SID = "cos-thread";
const info: CoordinatorResponse = {
  area: { id: "portfolio", title: "Portfolio" },
  agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
  sessionId: SID,
  sessionTitle: "Chief of staff",
  excluded: false,
  prompt: null,
  lastRunAt: null,
};
const at = "2026-11-16T15:00:00.000Z";
const said = { kind: "user", id: "u1", text: "Clean up the stale previews", at };
let n = 0;
let runId = "";
/** What GET /api/hermes/sessions/:id answers; a test changes it to move the conversation on. */
let session: { session: object; timeline: object[] };
let client: QueryClient;
const sessionReads = () => vi.mocked(api.get).mock.calls.filter(([path]) => path === `/api/hermes/sessions/${SID}`).length;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
  runId = `run_live_${++n}`;
  session = { session: { id: SID, activeRun: { runId, status: "running" } }, timeline: [said] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(api, "get").mockImplementation(async (path: string) => {
    if (path === `/api/hermes/sessions/${SID}`) return session;
    if (path === `/api/hermes/runs/${runId}`) return { status: "running" };
    if (path.endsWith("/execution")) return { records: [], sources: [] };
    return {};
  });
  vi.spyOn(api, "post").mockResolvedValue({});
});
afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(LINGER_MS + 10);
  expect(openRunStreams()).toBe(0);
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  render(
    <QueryClientProvider client={client}>
      <CoordinatorThread info={info} compact name="Chief of staff" />
    </QueryClientProvider>,
  );
  await settle(10);
  expect(open()).toHaveLength(1);
  return FakeSource.all[0]!;
}
const live = () => screen.getByTestId("gc-live");
const field = () => screen.getByTestId("gc-input") as HTMLTextAreaElement;
const send = () => screen.getByTestId("coordinator-send") as HTMLButtonElement;

it("a run in flight is followed on its stream: the reply appears as it is written, with its steps", async () => {
  const stream = await mount();
  expect(stream.url).toBe(`/api/hermes/runs/${runId}/events?format=agui`);
  act(() => stream.emit({ type: "tool.started", tool: "search_files", preview: "previews older than 30 days", at, callId: "c1" }, 1));
  act(() => stream.emit({ type: "tool.completed", tool: "search_files", preview: "35 found", at, callId: "c1", durationSec: 2 }, 2));
  act(() => stream.emit({ type: "text.delta", delta: "35 previews have had no traffic" }, 3));
  await settle(120);
  expect(within(live()).getByText("35 previews have had no traffic")).toBeTruthy();
  expect(within(live()).getByRole("button", { name: /^Working/ })).toBeTruthy();
  // The words in the composer are guidance for this run now.
  expect(field().placeholder).toBe("Add guidance…");
});

it("the conversation is not polled while its run is streaming", async () => {
  await mount();
  const reads = sessionReads();
  await settle(10_000);
  expect(sessionReads()).toBe(reads);
});

it("an approval the run is waiting on is answered in the panel", async () => {
  const stream = await mount();
  act(() =>
    stream.emit(
      {
        type: "approval.requested",
        at,
        requestId: "ap_1",
        command: "rm -rf build",
        description: "Recursive delete",
        choices: ["once", "session", "always", "deny"],
      },
      1,
    ),
  );
  await settle(10);
  const card = within(live()).getByRole("group", { name: /needs your approval/ });
  expect(within(card).getByText("rm -rf build")).toBeTruthy();
  // Nothing can be sent past an approval that is waiting: the composer says so.
  expect(field().placeholder).toBe("Approve or deny first");
  expect(send().disabled).toBe(true);
  fireEvent.click(within(card).getByRole("button", { name: "Approve once" }));
  // Approvals wait with Undo; "Send now" skips the wait.
  fireEvent.click(within(card).getByRole("button", { name: "Send now" }));
  await settle(10);
  expect(api.post).toHaveBeenCalledExactlyOnceWith(`/api/hermes/runs/${runId}/approval`, { choice: "once", requestId: "ap_1" });
});

it("a question the run asks is answered in the panel", async () => {
  const stream = await mount();
  act(() => stream.emit({ type: "clarify.requested", at, requestId: "cl_1", question: "Keep the six previews that still get visits?", choices: [] }, 1));
  await settle(10);
  const card = within(live()).getByTestId("clarify-card");
  expect(within(card).getByText("Keep the six previews that still get visits?")).toBeTruthy();
  fireEvent.change(within(card).getByRole("textbox", { name: "Your answer" }), { target: { value: "Yes, keep them" } });
  fireEvent.submit(within(card).getByRole("textbox", { name: "Your answer" }).closest("form")!);
  await settle(10);
  expect(api.post).toHaveBeenCalledExactlyOnceWith(`/api/hermes/runs/${runId}/clarify`, { answer: "Yes, keep them", requestId: "cl_1" });
});

it("when the run finishes the saved reply replaces the live copy: it is on screen once, and the stream is closed", async () => {
  const stream = await mount();
  act(() => stream.emit({ type: "text.delta", delta: "Deleted 35 previews." }, 1));
  await settle(120);
  // Hermes confirms the end, and the conversation now has the reply.
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === `/api/hermes/sessions/${SID}`) return session;
    if (path === `/api/hermes/runs/${runId}`) return { status: "completed", output: "Deleted 35 previews." };
    if (path.endsWith("/execution")) return { records: [], sources: [] };
    return {};
  });
  session = { session: { id: SID }, timeline: [said, { kind: "assistant", id: "a1", text: "Deleted 35 previews.", at }] };
  act(() => stream.emit({ type: "run.terminal", status: "completed", output: "Deleted 35 previews." }, 2));
  await settle(50);
  await settle(50);
  expect(screen.queryByTestId("gc-live")).toBeNull();
  expect(screen.getAllByText("Deleted 35 previews.")).toHaveLength(1);
  expect(open()).toHaveLength(0);
  expect(field().placeholder).toBe("Ask your chief of staff…");
});

it("a stream that missed the ending lets go once the conversation, freshly read, says nothing is running", async () => {
  const stream = await mount();
  act(() => stream.emit({ type: "text.delta", delta: "Half an ans" }, 1));
  await settle(120);
  expect(screen.getByTestId("gc-live")).toBeTruthy();
  session = { session: { id: SID }, timeline: [said, { kind: "assistant", id: "a1", text: "The whole answer.", at }] };
  await act(async () => {
    await client.refetchQueries({ queryKey: ["session", SID] });
  });
  await settle(10);
  expect(screen.queryByTestId("gc-live")).toBeNull();
  expect(screen.getByText("The whole answer.")).toBeTruthy();
  expect(open()).toHaveLength(0);
});

it("a stream that cannot reach the run does not block the composer, and the conversation is polled again", async () => {
  const stream = await mount();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === `/api/hermes/sessions/${SID}`) return session;
    if (path === `/api/hermes/runs/${runId}`) throw new Error("not found");
    if (path.endsWith("/execution")) return { records: [], sources: [] };
    return {};
  });
  act(() => stream.onerror?.());
  await settle(10);
  expect(within(live()).getByRole("status").textContent).toContain("reconnecting");
  // Guidance does not travel on the stream: it can still be sent.
  fireEvent.change(field(), { target: { value: "Skip the archive tab" } });
  expect(send().disabled).toBe(false);
  // With no stream to say how the run ends, the saved conversation is asked again.
  const reads = sessionReads();
  await settle(3_200);
  expect(sessionReads()).toBeGreaterThan(reads);
});

it("a run that finished clears only its own live copy: another thread opened meanwhile keeps the run it is following", async () => {
  const stream = await mount();
  const OTHER = "earlier-thread";
  const first = runId;
  const second = "run_in_other_thread";
  const other = { session: { id: OTHER, activeRun: { runId: second, status: "running" } }, timeline: [said] };
  // The finished run's refresh of its conversation is still on its way when the owner opens another thread.
  let arrive = () => {};
  const late = new Promise<typeof session>((resolve) => {
    arrive = () => resolve({ session: { id: SID }, timeline: [said, { kind: "assistant", id: "a1", text: "Done.", at }] });
  });
  let ended = false;
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === `/api/hermes/sessions/${SID}`) return ended ? late : session;
    if (path === `/api/hermes/sessions/${OTHER}`) return other;
    if (path === `/api/hermes/runs/${first}`) return { status: "completed", output: "Done." };
    if (path === `/api/hermes/runs/${second}`) return { status: "running" };
    if (path.startsWith("/api/work/conversations")) return { conversations: [{ id: OTHER, title: "Last week", placement: { parentId: "portfolio" } }] };
    if (path.endsWith("/execution")) return { records: [], sources: [] };
    return {};
  });
  // The thread list was read at mount, before this earlier thread existed: read it again.
  await act(() => client.invalidateQueries({ queryKey: ["work", "conversations"] }));
  await settle(10);
  fireEvent.click(screen.getByRole("button", { name: /^Earlier · Last week/ }));
  await settle(10);
  ended = true;
  act(() => stream.emit({ type: "run.terminal", status: "completed", output: "Done." }, 1));
  await settle(50);
  fireEvent.click(screen.getByRole("button", { name: /^Continue Last week/ }));
  await settle(50);
  const following = () => open().map((s) => s.url);
  expect(following()).toEqual([`/api/hermes/runs/${second}/events?format=agui`]);
  // Now the first thread's refresh lands.
  arrive();
  await settle(50);
  await settle(50);
  expect(following()).toEqual([`/api/hermes/runs/${second}/events?format=agui`]);
  act(() => open()[0]!.emit({ type: "text.delta", delta: "Still writing in the other thread" }, 1));
  await settle(120);
  expect(within(live()).getByText("Still writing in the other thread")).toBeTruthy();
});
