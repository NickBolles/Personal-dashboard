// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ChatExecutionResponse } from "@/lib/chat-execution";
import { useChatThings } from "./useChatThings";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/api", () => ({ api: { get } }));
const execution = (state: "running" | "completed"): ChatExecutionResponse => ({
  sessionId: "parent/id",
  parent: null,
  records: [{ key: "child", id: "child", source: "subagent", title: "Builder", state }],
  sources: [{ source: "transcript", state: "ok" }],
  fetchedAt: "2026-11-05T00:00:00Z",
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(() => useChatThings("parent/id", { links: [] }), { wrapper: Wrapper });
  return { ...hook, client };
}
const tick = async (ms = 10) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("polls active execution at 20 seconds and inactive execution at 60 seconds", async () => {
  get.mockResolvedValue(execution("running"));
  const { result } = setup();
  await tick();
  expect(get).toHaveBeenCalledWith("/api/hermes/sessions/parent%2Fid/execution");
  expect(result.current.things.counts.running).toBe(1);
  await tick(19_000);
  expect(get).toHaveBeenCalledTimes(1);
  get.mockResolvedValue(execution("completed"));
  await tick(1_000);
  expect(get).toHaveBeenCalledTimes(2);
  expect(result.current.things.counts.running).toBe(0);
  await tick(59_000);
  expect(get).toHaveBeenCalledTimes(2);
  await tick(1_000);
  expect(get).toHaveBeenCalledTimes(3);
});

it("does not acknowledge a future finished result when the running tab was viewed", async () => {
  get.mockResolvedValue(execution("running"));
  const { result, client } = setup();
  await tick();
  act(() => result.current.markSeen("Running"));
  act(() => client.setQueryData(["chat-execution", "parent/id"], execution("completed")));
  await tick();
  expect(result.current.things.line).toMatchObject({ state: "finished", dot: "yellow" });
  act(() => result.current.markSeen("Running"));
  expect(result.current.things.line.dot).toBeNull();
});

it("reports an unavailable source on request failure and supports Retry", async () => {
  get.mockRejectedValue(new Error("offline"));
  const { result } = setup();
  await tick();
  expect(result.current.error).toBe(true);
  expect(result.current.things.counts.running).toBeNull();
  get.mockResolvedValue({ ...execution("running"), records: [] });
  act(() => result.current.retry());
  await tick();
  expect(result.current.error).toBe(false);
  expect(result.current.things.counts.running).toBe(0);
});

it("rejects an endpoint response without the shared execution contract", async () => {
  get.mockResolvedValue({});
  const { result } = setup();
  await tick();
  expect(result.current.error).toBe(true);
  expect(result.current.things.counts.running).toBeNull();
});
