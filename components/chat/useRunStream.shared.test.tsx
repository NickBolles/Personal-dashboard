// @vitest-environment jsdom
/**
 * One Hermes stream per run, however many readers show it (docs/hermes-connection-budget.md). These tests count the
 * EventSource connections the page opens: the rail, the phone sheet and a full page can all read the same run, and
 * that must cost one connection, not one each.
 */
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { LINGER_MS, openRunStreams } from "@/lib/client/run-streams";
import { useRunStream, type RunState } from "./useRunStream";

vi.mock("@/lib/client/api", () => ({ api: { get: vi.fn(async () => ({ status: "running" })), post: vi.fn() } }));

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
const text = (delta: string) => ({ type: "text.delta", delta });
const terminal = { type: "run.terminal", status: "completed", output: "Done." };

let n = 0;
const runId = () => `run_shared_${++n}`;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
  vi.mocked(api.get).mockImplementation(async () => ({ status: "running" }));
});
afterEach(async () => {
  cleanup();
  // Let every stream these readers left behind close, so no test starts with another's connection.
  await vi.advanceTimersByTimeAsync(LINGER_MS + 10);
  expect(openRunStreams()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("two readers of the same run share one connection and see the same state", async () => {
  const id = runId();
  const rail = renderHook(() => useRunStream(() => {}));
  const page = renderHook(() => useRunStream(() => {}));
  act(() => rail.result.current.start(id));
  act(() => page.result.current.start(id));
  expect(FakeSource.all).toHaveLength(1);
  expect(FakeSource.all[0]!.url).toBe(`/api/hermes/runs/${id}/events?format=agui`);
  act(() => FakeSource.all[0]!.emit(text("Hello"), 1));
  await settle(120);
  expect(rail.result.current.state.text).toBe("Hello");
  expect(page.result.current.state.text).toBe("Hello");
  expect(rail.result.current.state).toBe(page.result.current.state);
  expect(rail.result.current.active).toBe(true);
});

it("a reader that joins a run already streaming gets what has arrived so far, without a replay", async () => {
  const id = runId();
  const rail = renderHook(() => useRunStream(() => {}));
  act(() => rail.result.current.start(id));
  act(() => FakeSource.all[0]!.emit(text("Half a sen"), 4));
  await settle(120);
  const page = renderHook(() => useRunStream(() => {}));
  act(() => page.result.current.start(id, "queued"));
  expect(FakeSource.all).toHaveLength(1);
  expect(page.result.current.state.text).toBe("Half a sen");
  expect(page.result.current.state.phase).toBe("running");
});

it("the stream stays open while one reader is left, and closes shortly after the last one leaves", async () => {
  const id = runId();
  const rail = renderHook(() => useRunStream(() => {}));
  const page = renderHook(() => useRunStream(() => {}));
  act(() => rail.result.current.start(id));
  act(() => page.result.current.start(id));
  page.unmount();
  await settle(LINGER_MS + 10);
  expect(open()).toHaveLength(1);
  rail.unmount();
  expect(open()).toHaveLength(1);
  await settle(LINGER_MS + 10);
  expect(open()).toHaveLength(0);
  expect(FakeSource.all).toHaveLength(1);
});

it("a reader that comes straight back picks the stream up again: no second connection, nothing lost", async () => {
  const id = runId();
  const first = renderHook(() => useRunStream(() => {}));
  act(() => first.result.current.start(id));
  act(() => FakeSource.all[0]!.emit(text("Kept"), 2));
  await settle(120);
  first.unmount();
  await settle(LINGER_MS - 200);
  const second = renderHook(() => useRunStream(() => {}));
  act(() => second.result.current.start(id));
  await settle(LINGER_MS + 10);
  expect(FakeSource.all).toHaveLength(1);
  expect(open()).toHaveLength(1);
  expect(second.result.current.state.text).toBe("Kept");
});

it("a reader mounted twice by StrictMode still holds its stream after the first mount is thrown away", async () => {
  const id = runId();
  const reader = renderHook(() => useRunStream(() => {}), { wrapper: StrictMode });
  act(() => reader.result.current.start(id));
  await settle(LINGER_MS + 10);
  expect(FakeSource.all).toHaveLength(1);
  expect(open()).toHaveLength(1);
});

it("each reader is told once when the run finishes, and the connection is closed", async () => {
  const id = runId();
  vi.mocked(api.get).mockImplementation(async () => ({ status: "completed", output: "Done." }));
  const seenByRail = vi.fn<(s: RunState) => void>();
  const seenByPage = vi.fn<(s: RunState) => void>();
  const rail = renderHook(() => useRunStream(seenByRail));
  const page = renderHook(() => useRunStream(seenByPage));
  act(() => rail.result.current.start(id));
  act(() => page.result.current.start(id));
  act(() => FakeSource.all[0]!.emit(text("Done."), 1));
  act(() => FakeSource.all[0]!.emit(terminal, 2));
  await settle(10);
  expect(seenByRail).toHaveBeenCalledTimes(1);
  expect(seenByPage).toHaveBeenCalledTimes(1);
  expect(seenByRail.mock.calls[0]![0]).toMatchObject({ runId: id, phase: "completed", text: "Done." });
  expect(open()).toHaveLength(0);
  expect(rail.result.current.active).toBe(false);
  // The reconcile that confirmed it asked Hermes once, not once per reader.
  expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === `/api/hermes/runs/${id}`)).toHaveLength(1);
  await settle(1000);
  expect(seenByRail).toHaveBeenCalledTimes(1);
});

it("clear lets go of the run for that reader only; the last reader's clear closes the connection at once", async () => {
  const id = runId();
  const rail = renderHook(() => useRunStream(() => {}));
  const page = renderHook(() => useRunStream(() => {}));
  act(() => rail.result.current.start(id));
  act(() => page.result.current.start(id));
  act(() => FakeSource.all[0]!.emit(text("Still going"), 1));
  await settle(120);
  act(() => page.result.current.clear());
  expect(page.result.current.state.runId).toBeUndefined();
  expect(page.result.current.state.text).toBe("");
  expect(rail.result.current.state.text).toBe("Still going");
  expect(open()).toHaveLength(1);
  act(() => rail.result.current.clear());
  expect(open()).toHaveLength(0);
});

it("different runs get their own connections, and moving a reader to a new run lets go of the old one", async () => {
  const a = runId();
  const b = runId();
  const reader = renderHook(() => useRunStream(() => {}));
  act(() => reader.result.current.start(a));
  act(() => reader.result.current.start(b));
  expect(FakeSource.all.map((s) => s.url)).toEqual([`/api/hermes/runs/${a}/events?format=agui`, `/api/hermes/runs/${b}/events?format=agui`]);
  expect(reader.result.current.state.runId).toBe(b);
  await settle(LINGER_MS + 10);
  expect(open().map((s) => s.url)).toEqual([`/api/hermes/runs/${b}/events?format=agui`]);
});

it("a broken stream reconnects once for all readers, from the last event seen", async () => {
  const id = runId();
  const rail = renderHook(() => useRunStream(() => {}));
  const page = renderHook(() => useRunStream(() => {}));
  act(() => rail.result.current.start(id));
  act(() => page.result.current.start(id));
  act(() => FakeSource.all[0]!.emit(text("Before"), 7));
  await settle(120);
  act(() => FakeSource.all[0]!.onerror?.());
  await settle(10);
  // Hermes still reports the run as running, so both readers show the first reconnect attempt.
  expect(rail.result.current.state.attempts).toBe(1);
  expect(page.result.current.state.attempts).toBe(1);
  expect(open()).toHaveLength(0);
  await settle(1000);
  expect(FakeSource.all).toHaveLength(2);
  expect(FakeSource.all[0]!.closed).toBe(true);
  expect(FakeSource.all[1]!.url).toBe(`/api/hermes/runs/${id}/events?format=agui&lastSeq=7`);
  act(() => FakeSource.all[1]!.emit(text(" and after"), 8));
  await settle(120);
  expect(page.result.current.state.text).toBe("Before and after");
  expect(page.result.current.state.phase).toBe("running");
});

it("stop asked by one reader stops the run for all of them", async () => {
  const id = runId();
  vi.mocked(api.post).mockImplementation(async () => ({ status: "cancelled" }));
  const seenByPage = vi.fn();
  const rail = renderHook(() => useRunStream(() => {}));
  const page = renderHook(() => useRunStream(seenByPage));
  act(() => rail.result.current.start(id));
  act(() => page.result.current.start(id));
  await act(async () => {
    await rail.result.current.stop();
  });
  expect(api.post).toHaveBeenCalledExactlyOnceWith(`/api/hermes/runs/${id}/stop`);
  expect(page.result.current.state.phase).toBe("cancelled");
  expect(seenByPage).toHaveBeenCalledTimes(1);
  expect(open()).toHaveLength(0);
});
