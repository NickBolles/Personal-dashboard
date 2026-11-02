// @vitest-environment jsdom
/** #162: a failed agent-capture PATCH is retried with backoff, then shows as unsaved with a manual Retry. */
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const patch = vi.fn();
vi.mock("@/lib/client/api", () => ({ api: { patch: (...a: unknown[]) => patch(...a), get: vi.fn(), post: vi.fn() } }));

import { CAPTURE_RETRY_MS, useAgentCapture, type RunPanelView } from "@/components/workflows/RunPanel";

const run = { id: "run1", status: "live" } as unknown as RunPanelView;
const turn = { kind: "assistant", id: "m1", text: "ok\n```jarvis-capture\n{}\n```" } as never;
const ok = { run, applied: ["x"], dropped: 0, proposed: 0 };

function wrap() {
  const qc = new QueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  patch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("retries a failed capture on a timer until it lands", async () => {
  patch.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ok);
  const onApplied = vi.fn();
  const { result } = renderHook(() => useAgentCapture("s1", run, [turn], onApplied), { wrapper: wrap() });
  await act(async () => {});
  expect(patch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CAPTURE_RETRY_MS[0]);
  });
  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch.mock.calls[1]![1]).toMatchObject({ by: "agent", messageId: "m1" });
  expect(onApplied).toHaveBeenCalledTimes(1);
  expect(result.current.unsaved).toBe(0);
});

it("after the last backoff the turn is unsaved; Retry sends it again", async () => {
  patch.mockRejectedValue(new Error("down"));
  const onApplied = vi.fn();
  const { result } = renderHook(() => useAgentCapture("s1", run, [turn], onApplied), { wrapper: wrap() });
  await act(async () => {});
  for (const ms of CAPTURE_RETRY_MS)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  expect(patch).toHaveBeenCalledTimes(CAPTURE_RETRY_MS.length + 1);
  expect(result.current.unsaved).toBe(1);
  patch.mockReset();
  patch.mockResolvedValueOnce(ok);
  await act(async () => {
    result.current.retry();
  });
  expect(patch).toHaveBeenCalledTimes(1);
  expect(result.current.unsaved).toBe(0);
  expect(onApplied).toHaveBeenCalledTimes(1);
});
