// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { useSessions } from "@/components/chat/SessionList";
import type { SessionPage } from "@/lib/session-pages";

vi.mock("next/navigation", () => ({ usePathname: () => "/chat", useRouter: () => ({ push: vi.fn() }) }));
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return renderHook(() => useSessions(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}
const page = (id: string, nextOffset: number | null): SessionPage => ({ sessions: id ? [{ id, title: id, pinned: false, archived: false }] : [], nextOffset });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
});

describe("incremental chat loading", () => {
  it.each([
    ["manual", "first", false],
    ["manual", "", false],
    ["mutation", "first", false],
    ["mutation", "", false],
    ["manual", "", true],
    ["mutation", "", true],
  ] as const)("%s refresh preserves pages with head '%s' on failure (partial=%s), then resets on retry", async (kind, first, partial) => {
    let finish!: (value: SessionPage) => void;
    let fail!: (error: Error) => void;
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(page(first, 20))
      .mockResolvedValueOnce(page("older", 40))
      .mockImplementationOnce(
        () =>
          new Promise<SessionPage>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      )
      .mockResolvedValueOnce(page("fresh", 20))
      .mockResolvedValueOnce(page("next", null));
    const { result } = mount();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const old = result.current.data;
    let refreshing!: Promise<unknown>;
    act(() => {
      refreshing = kind === "manual" ? result.current.refetch() : refreshSessionLists(clients[0]!);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(result.current.data).toEqual(old);
    await act(async () => {
      if (partial) finish({ ...page("local", 0), unavailable: ["Hermes"] });
      else fail(new Error("Hermes timeout"));
      await refreshing;
    });
    await waitFor(() => expect(result.current.fromCache).toBe(true));
    expect(result.current.isFetchNextPageError).toBe(false);
    expect(result.current.data).toEqual(old);
    expect(result.current.sessions?.map((s) => s.id)).toEqual(first ? [first, "older"] : ["older"]);
    expect(get).toHaveBeenCalledTimes(3);
    await act(() => result.current.refetch());
    await waitFor(() => expect(result.current.sessions?.map((s) => s.id)).toEqual(["fresh"]));
    expect(result.current.data?.pageParams).toEqual([0]);
    expect(result.current.fromCache).toBe(false);
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.sessions?.map((s) => s.id)).toEqual(["fresh", "next"]));
    expect(get.mock.calls.map((c) => c[0])).toEqual([0, 20, 0, 0, 20].map((offset) => `/api/hermes/sessions?offset=${offset}`));
  });

  it.each(["manual", "mutation"])("cancels a %s head refresh on unmount without discarding history", async (kind) => {
    let signal: AbortSignal | undefined;
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(page("", 20))
      .mockResolvedValueOnce(page("older", 40))
      .mockImplementationOnce((_path, s) => {
        signal = s;
        return new Promise(() => {});
      });
    const { result, unmount } = mount();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());
    const old = clients[0]!.getQueryData(["sessions", false]);
    let refreshing!: Promise<unknown>;
    act(() => {
      refreshing = kind === "manual" ? result.current.refetch() : refreshSessionLists(clients[0]!);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    unmount();
    await refreshing;
    expect(signal?.aborted).toBe(true);
    expect(clients[0]!.getQueryData(["sessions", false])).toEqual(old);
  });

  it.each(["manual", "mutation"])("%s refresh cancels a pending continuation and ignores its late result", async (kind) => {
    let signal: AbortSignal | undefined;
    let finish!: (value: SessionPage) => void;
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(page("", 20))
      .mockResolvedValueOnce(page("older", 40))
      .mockImplementationOnce((_path, s) => {
        signal = s;
        return new Promise<SessionPage>((resolve) => {
          finish = resolve;
        });
      })
      .mockResolvedValueOnce(page("fresh", 20));
    const { result } = mount();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());
    let continuation!: Promise<unknown>;
    act(() => {
      continuation = result.current.fetchNextPage();
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await act(async () => {
      await (kind === "manual" ? result.current.refetch() : refreshSessionLists(clients[0]!));
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish(page("cancelled", null));
      await continuation;
    });
    await waitFor(() => expect(result.current.sessions?.map((s) => s.id)).toEqual(["fresh"]));
    expect(result.current.data?.pageParams).toEqual([0]);
    expect(get.mock.calls.map((c) => c[0])).toEqual([0, 20, 40, 0].map((offset) => `/api/hermes/sessions?offset=${offset}`));
  });

  it("chat mutation invalidation refreshes only the head window", async () => {
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(page("first", 20))
      .mockResolvedValueOnce(page("older", null))
      .mockResolvedValueOnce(page("updated", 20));
    const { result } = mount();
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(() => result.current.fetchNextPage());
    await act(() => refreshSessionLists(clients[0]!));
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/api/hermes/sessions?offset=0", "/api/hermes/sessions?offset=20", "/api/hermes/sessions?offset=0"]);
    await waitFor(() => expect(result.current.sessions?.map((s) => s.id)).toEqual(["updated"]));
  });
  it("does not stop on an empty owned page; requests one continuation and deduplicates overlapping pins", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValueOnce(page("", 20)).mockResolvedValueOnce(page("pin", 40)).mockResolvedValueOnce(page("pin", null));
    const { result } = mount();
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
    await act(() => result.current.fetchNextPage());
    expect(get.mock.calls[1]?.[0]).toBe("/api/hermes/sessions?offset=20");
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.sessions?.map((s) => s.id)).toEqual(["pin"]);
  });

  it("retains stale rows and the failed offset, with explicit manual retry only", async () => {
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(page("first", 20))
      .mockRejectedValueOnce(new Error("Hermes timeout"))
      .mockResolvedValueOnce(page("older", null));
    const { result } = mount();
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.fromCache).toBe(true);
    expect(result.current.sessions?.[0]?.id).toBe("first");
    expect(get).toHaveBeenCalledTimes(2);
    await act(() => result.current.fetchNextPage());
    expect(get.mock.calls[2]?.[0]).toBe("/api/hermes/sessions?offset=20");
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  });

  it("refresh requests only the first window, not all loaded pages", async () => {
    const get = vi
      .spyOn(api, "get")
      .mockResolvedValueOnce(page("first", 20))
      .mockResolvedValueOnce(page("older", null))
      .mockResolvedValueOnce(page("fresh", 20));
    const { result } = mount();
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(() => result.current.fetchNextPage());
    await act(() => result.current.refetch());
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/api/hermes/sessions?offset=0", "/api/hermes/sessions?offset=20", "/api/hermes/sessions?offset=0"]);
    await waitFor(() => expect(result.current.sessions?.map((s) => s.id)).toEqual(["fresh"]));
  });

  it("cancels an in-flight page when its observer unmounts", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "get").mockImplementation((_path, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = mount();
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("does not replace existing Hermes rows with a local-only partial success", async () => {
    vi.spyOn(api, "get")
      .mockResolvedValueOnce(page("remote", 20))
      .mockResolvedValueOnce({ ...page("local", 0), unavailable: ["Hermes"] });
    const { result } = mount();
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(() => result.current.refetch());
    await waitFor(() => expect(result.current.fromCache).toBe(true));
    expect(result.current.sessions?.[0]?.id).toBe("remote");
  });
});
