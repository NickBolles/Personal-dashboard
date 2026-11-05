// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { useChatPanelLayout } from "./useChatPanelLayout";
import { setPanelOwner, usePanelOwner } from "@/lib/client/panel-owner";

let resize: ResizeObserverCallback;
const disconnect = vi.fn();
beforeEach(() => {
  disconnect.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  cleanup();
  setPanelOwner(null);
  vi.unstubAllGlobals();
});
const size = (width: number) => act(() => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));

it("uses the measured chat container and releases rail ownership on collapse or unmount", () => {
  const wrapper = createRef<HTMLDivElement>();
  wrapper.current = document.createElement("div");
  const { result, unmount } = renderHook(() => ({ surface: useChatPanelLayout("s", wrapper, true), owner: usePanelOwner() }));
  size(899);
  expect(result.current.surface.wide).toBe(false);
  expect(result.current.owner).toBeNull();
  act(() => result.current.surface.show("Running"));
  expect(result.current.surface.open).toBe(true);
  expect(result.current.owner).toBeNull();
  size(900);
  expect(result.current.surface.wide).toBe(true);
  expect(result.current.owner).toBe("s");
  act(() => result.current.surface.close());
  expect(result.current.owner).toBeNull();
  act(() => result.current.surface.show("Context"));
  expect(result.current.owner).toBe("s");
  unmount();
  const owner = renderHook(usePanelOwner);
  expect(owner.result.current).toBeNull();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("updates the owner across chat navigation and defaults workflows to Outline", () => {
  const wrapper = createRef<HTMLDivElement>();
  wrapper.current = document.createElement("div");
  const { result, rerender } = renderHook(({ id }) => ({ surface: useChatPanelLayout(id, wrapper, true, true), owner: usePanelOwner() }), {
    initialProps: { id: "first" },
  });
  size(1000);
  expect(result.current.surface.tab).toBe("Outline");
  expect(result.current.owner).toBe("first");
  rerender({ id: "second" });
  expect(result.current.owner).toBe("second");
  size(700);
  expect(result.current.owner).toBeNull();
});
