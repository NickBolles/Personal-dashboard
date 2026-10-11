// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import * as sessionLists from "@/lib/client/session-lists";
import { NewConversationButton, useSessions } from "@/components/chat/SessionList";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { CompassView } from "@/app/(shell)/daily-compass/CompassView";
import type { SessionPage } from "@/lib/session-pages";

const { push, toast } = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/chat", useRouter: () => ({ push }) }));
vi.mock("@/components/chat/backend", () => ({ useAssistantChoice: () => ({ backend: "hermes" }) }));
vi.mock("@/components/ui", async (original) => ({ ...(await original<object>()), useToast: () => ({ toast }) }));
vi.mock("@/lib/client/idb", () => ({
  kvGet: vi.fn().mockResolvedValue(undefined),
  kvSet: vi.fn().mockResolvedValue(undefined),
  kvDel: vi.fn().mockResolvedValue(undefined),
}));
const clients: QueryClient[] = [];
const page = (id: string, nextOffset: number | null): SessionPage => ({ sessions: [{ id, title: id, pinned: false, archived: false }], nextOffset });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe.each(["button", "capture", "compass"] as const)("%s conversation creation", (entry) => {
  it.each(["success", "inactive", "timeout", "helper rejection"] as const)(
    "refreshes safely on %s without delaying navigation or replaying history",
    async (outcome) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      let finish!: (value: SessionPage) => void;
      let fail!: (error: Error) => void;
      let listCalls = 0;
      const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
        if (path === "/api/daily-compass") return { enabled: true, mode: "hermes", state: { completed: false } };
        listCalls++;
        if (listCalls === 1) return page("first", 20);
        if (listCalls === 2) return page("older", null);
        return new Promise<SessionPage>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      });
      const refresh = vi.spyOn(sessionLists, "refreshSessionLists");
      if (outcome === "helper rejection") refresh.mockRejectedValue(new Error("Refresh unavailable"));
      const post = vi.spyOn(api, "post").mockImplementation(async (path) => {
        if (path === "/api/daily-compass/start") return { sessionId: "new/id", runId: "run/id" };
        if (path === "/api/hermes/sessions") return page("new/id", null).sessions[0];
        return { runId: "run/id" };
      });
      const mounted = renderHook(() => useSessions(), { wrapper });
      let result = mounted.result;
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      await act(() => result.current.fetchNextPage());
      await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
      const old = result.current.data;
      if (outcome === "inactive") {
        mounted.unmount();
        const unchanged = renderHook(() => useSessions(), { wrapper });
        expect(listCalls).toBe(2);
        expect(unchanged.result.current.isFetching).toBe(false);
        unchanged.unmount();
      }
      render(entry === "button" ? <NewConversationButton /> : entry === "capture" ? <QuickCapture initialText="Hello" /> : <CompassView />, { wrapper });
      fireEvent.click(
        await screen.findByRole("button", {
          name: entry === "button" ? "New conversation" : entry === "capture" ? "Send to Hermes" : "Start check-in with Hermes",
        }),
      );
      await waitFor(() => expect(push).toHaveBeenCalledWith(`/chat/new%2Fid${entry === "compass" ? "?run=run%2Fid" : ""}`));
      expect(refresh).toHaveBeenCalledExactlyOnceWith(client);
      if (outcome === "inactive") {
        await waitFor(() => expect(client.getQueryState(["sessions", false])?.isInvalidated).toBe(true));
        expect(listCalls).toBe(2);
        result = renderHook(() => useSessions(), { wrapper }).result;
      }
      expect(result.current.data).toEqual(old);
      if (outcome !== "helper rejection") {
        await waitFor(() => expect(listCalls).toBe(3));
        await act(async () => {
          if (outcome === "timeout") fail(new Error("Hermes timeout"));
          else finish(page("new/id", 20));
        });
        await waitFor(() => expect(result.current.isFetching).toBe(false));
        if (outcome === "success" || outcome === "inactive") {
          expect(result.current.sessions?.map((s) => s.id)).toEqual(["new/id"]);
          expect(result.current.data?.pageParams).toEqual([0]);
        } else {
          expect(result.current.fromCache).toBe(true);
          expect(result.current.data).toEqual(old);
        }
      }
      expect(get.mock.calls.filter(([path]) => path.startsWith("/api/hermes/sessions")).map(([path]) => path)).toEqual(
        (outcome === "helper rejection" ? [0, 20] : [0, 20, 0]).map((offset) => `/api/hermes/sessions?offset=${offset}`),
      );
      expect(push).toHaveBeenCalledTimes(1);
      expect(post.mock.calls.filter(([path]) => path === "/api/hermes/sessions" || path === "/api/daily-compass/start")).toHaveLength(1);
      expect(toast).not.toHaveBeenCalledWith(expect.anything(), "danger");
      if (outcome === "helper rejection") expect(toast).toHaveBeenCalledWith(expect.stringContaining("Conversation created"), "warn");
    },
  );
});
