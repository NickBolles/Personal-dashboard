// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HIDDEN_GRACE_MS, useRunStream } from "./useRunStream";

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
}

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  visibility = "visible";
});

it("a stream opened in an already-hidden tab is released after the grace period (#253)", async () => {
  visibility = "hidden";
  const { result } = renderHook(() => useRunStream(() => {}));
  act(() => result.current.start("run_1"));
  expect(FakeSource.all).toHaveLength(1);
  expect(FakeSource.all[0]!.closed).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS + 10);
  });
  expect(FakeSource.all[0]!.closed).toBe(true);
});

it("a stream in a visible tab stays open", async () => {
  const { result } = renderHook(() => useRunStream(() => {}));
  act(() => result.current.start("run_2"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS + 10);
  });
  expect(FakeSource.all[0]!.closed).toBe(false);
});
