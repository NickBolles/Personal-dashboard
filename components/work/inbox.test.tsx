// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxEntry } from "@/lib/work";
import { InboxView } from "./inbox";

const state = vi.hoisted(() => ({ resize: null as ResizeObserverCallback | null, disconnect: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => false }) }));
vi.mock("@/components/work/common", () => ({ useWorkMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/components/work/today", () => ({
  useInbox: () => ({
    data: {
      items: [
        {
          id: "issue",
          source: "github_issue",
          title: "Resize the preview",
          note: "",
          url: null,
          repo: "mock/repo",
          number: 7,
          reason: "Assigned to you",
          createdAt: "2026-11-07T18:00:00Z",
        } satisfies InboxEntry,
      ],
      count: 1,
    },
    isPending: false,
    error: null,
  }),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        state.resize = callback;
      }
      observe() {}
      disconnect = state.disconnect;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.resize = null;
  state.disconnect.mockClear();
});
function resize(width: number) {
  act(() => {
    state.resize?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}
it("keeps preview and row actions consistent with the container's 560px threshold on rail resize", () => {
  const view = render(<InboxView items={[]} onOpenItem={vi.fn()} />);
  const list = screen.getByRole("region", { name: "Assigned issues and captures" });
  resize(559);
  expect(screen.queryByTestId("inbox-preview")).toBeNull();
  expect(within(list).getByRole("button", { name: "Accept: Resize the preview" })).toBeDefined();
  resize(560);
  expect(screen.getByTestId("inbox-preview")).toBeDefined();
  expect(within(list).queryByRole("button", { name: "Accept: Resize the preview" })).toBeNull();
  expect(within(list).getByRole("button", { name: "Resize the preview" })).toBeDefined();
  resize(1000);
  expect(screen.getByTestId("inbox-preview")).toBeDefined();
  resize(450);
  expect(screen.queryByTestId("inbox-preview")).toBeNull();
  expect(within(list).getByRole("button", { name: "Accept: Resize the preview" })).toBeDefined();
  view.unmount();
  expect(state.disconnect).toHaveBeenCalledOnce();
});
