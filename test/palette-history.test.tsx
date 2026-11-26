// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePaletteHistory } from "@/lib/client/palette-history";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps Next router state and uses a single real history traversal to close", async () => {
  history.replaceState({ __NA: true, tree: ["kept"] }, "", "/areas?item=example");
  const onClose = vi.fn();
  const back = vi.spyOn(history, "back");
  const { result, rerender } = renderHook(({ open }) => usePaletteHistory(open, onClose), { initialProps: { open: true } });
  expect(history.state.__NA).toBe(true);
  expect(history.state.tree).toEqual(["kept"]);
  expect(history.state.jarvisPalette).toBeTruthy();
  let closed: Promise<void>;
  act(() => {
    closed = result.current();
    void result.current();
  });
  expect(back).toHaveBeenCalledTimes(1);
  await act(async () => {
    await closed;
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(location.pathname + location.search).toBe("/areas?item=example");
  expect(history.state.jarvisPalette).toBeUndefined();
  rerender({ open: false });
  rerender({ open: true });
  act(() => history.back());
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  expect(back).toHaveBeenCalledTimes(2);
});
