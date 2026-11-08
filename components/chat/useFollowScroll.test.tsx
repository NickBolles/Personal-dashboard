// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFollowScroll } from "./useFollowScroll";

let resize: () => void;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
function frame() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}
function Harness({ ready = true, message = true }: { ready?: boolean; message?: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const { detached, jumpToLatest } = useFollowScroll(content, bottom, ready);
  return (
    <>
      {ready ? (
        <div ref={content}>
          {message ? <p id="msg-rated">Rated reply</p> : null}
          <div ref={bottom} data-testid="bottom" />
        </div>
      ) : null}
      <output>{detached ? "detached" : "following"}</output>
      <button onClick={() => jumpToLatest()}>Focus composer</button>
      <button onClick={() => jumpToLatest(false, true)}>Send</button>
      <button onClick={() => jumpToLatest(true)}>Jump to latest</button>
    </>
  );
}
beforeEach(() => {
  frames = new Map();
  frameId = 0;
  window.history.replaceState(null, "", "/chat/s");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(3000);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits for the transcript, centers the permalink, and ignores growth and programmatic scrolls", () => {
  window.history.replaceState(null, "", "#msg-rated");
  const view = render(<Harness ready={false} />);
  frame();
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  resize(); // an observer notification before the first frame cannot win
  frame();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
  expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances[0]).toBe(document.getElementById("msg-rated"));
  expect(screen.getByText("detached")).toBeTruthy();
  vi.spyOn(window, "scrollY", "get").mockReturnValue(3000 - window.innerHeight);
  fireEvent.scroll(window); // scrollIntoView can land close to the bottom
  resize();
  frame();
  fireEvent.click(screen.getByRole("button", { name: "Focus composer" }));
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(screen.getByText("detached")).toBeTruthy();
});

it("resolves a message added after a cached/partial transcript loads", async () => {
  window.history.replaceState(null, "", "#msg-rated");
  const view = render(<Harness message={false} />);
  frame();
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  await act(async () => view.rerender(<Harness />));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
});

it.each(["Send", "Jump to latest"])("%s explicitly resumes following from a permalink", (label) => {
  window.history.replaceState(null, "", "#msg-rated");
  render(<Harness />);
  frame();
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(screen.getByText("following")).toBeTruthy();
  resize();
  frame();
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 3000 });
});

it.each(["wheel", "touch", "key", "scrollbar"])("user %s releases the permalink lock and scrolling to bottom reattaches", (kind) => {
  window.history.replaceState(null, "", "#msg-rated");
  render(<Harness />);
  frame();
  if (kind === "wheel") fireEvent.wheel(window, { deltaY: 100 });
  if (kind === "touch") {
    fireEvent.touchStart(window, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(window, { touches: [{ clientY: 50 }] });
  }
  if (kind === "key") fireEvent.keyDown(document.body, { key: "PageDown" });
  if (kind === "scrollbar") fireEvent.pointerDown(document.documentElement);
  vi.spyOn(window, "scrollY", "get").mockReturnValue(3000 - window.innerHeight);
  fireEvent.scroll(window);
  expect(screen.getByText("following")).toBeTruthy();
  resize();
  frame();
});

it("normal opening and growth follow the bottom, but scrolling up detaches", () => {
  render(<Harness />);
  frame();
  expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 3000 });
  resize();
  frame();
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
  fireEvent.wheel(window, { deltaY: -100 });
  resize();
  frame();
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
  expect(screen.getByText("detached")).toBeTruthy();
});

it("handles a hash change on an already loaded conversation", () => {
  render(<Harness />);
  frame();
  vi.mocked(window.scrollTo).mockClear();
  window.history.replaceState(null, "", "#msg-rated");
  fireEvent(window, new HashChangeEvent("hashchange"));
  frame();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  expect(window.scrollTo).not.toHaveBeenCalled();
});

it("cancels the opening frame on unmount", () => {
  const view = render(<Harness />);
  view.unmount();
  frame();
  expect(window.scrollTo).not.toHaveBeenCalled();
});

it("does not recenter a late anchor after the user sends", async () => {
  window.history.replaceState(null, "", "#msg-rated");
  const view = render(<Harness message={false} />);
  frame();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => view.rerender(<Harness />));
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});
