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
  const { detached, below, jumpToLatest } = useFollowScroll(content, bottom, ready);
  return (
    <>
      {ready ? (
        <div ref={content}>
          {message ? <p id="msg-rated">Rated reply</p> : null}
          <div ref={bottom} data-testid="bottom" />
        </div>
      ) : null}
      <output>{detached ? "detached" : "following"}</output>
      <output>{below ? "content below" : "nothing below"}</output>
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

it("offers a jump only while there really is content under the fold", () => {
  render(<Harness />);
  frame();
  // At the bottom of a long thread: scrolling up a little detaches, but there is nothing to jump to yet.
  vi.spyOn(window, "scrollY", "get").mockReturnValue(3000 - window.innerHeight);
  fireEvent.wheel(window, { deltaY: -100 });
  expect(screen.getByText("detached")).toBeTruthy();
  expect(screen.getByText("nothing below")).toBeTruthy();
  vi.spyOn(window, "scrollY", "get").mockReturnValue(3000 - window.innerHeight - 400);
  fireEvent.scroll(window);
  expect(screen.getByText("content below")).toBeTruthy();
  // New output arriving while detached keeps the offer; jumping clears it.
  resize();
  frame();
  expect(screen.getByText("content below")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(screen.getByText("following")).toBeTruthy();
  expect(screen.getByText("nothing below")).toBeTruthy();
});

it("an empty or short thread that fits the screen never detaches or offers a jump", () => {
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(window.innerHeight);
  render(<Harness />);
  frame();
  fireEvent.wheel(window, { deltaY: -100 });
  fireEvent.touchStart(window, { touches: [{ clientY: 100 }] });
  fireEvent.touchMove(window, { touches: [{ clientY: 200 }] });
  fireEvent.keyDown(document.body, { key: "PageUp" });
  expect(screen.getByText("following")).toBeTruthy();
  expect(screen.getByText("nothing below")).toBeTruthy();
});

/** A thread docked in a column: the element scrolls, the page does not. */
function DockedHarness() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const { detached, jumpToLatest } = useFollowScroll(content, bottom, true, scroller);
  return (
    <>
      <div ref={scroller} data-testid="scroller">
        <div ref={content}>
          <p>Reply</p>
          <div ref={bottom} />
        </div>
      </div>
      <output>{detached ? "detached" : "following"}</output>
      <button onClick={() => jumpToLatest(true)}>Jump to latest</button>
    </>
  );
}

it("follows inside its own scroller when the thread is docked: the page is never scrolled", () => {
  render(<DockedHarness />);
  const scroller = screen.getByTestId("scroller");
  let top = 0;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  const scrollTo = vi.fn((opts: ScrollToOptions) => void (top = Math.min(opts.top ?? 0, 1500)));
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
  // Opening lands on the latest message, in the element.
  frame();
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: "auto" });
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(screen.getByText("following")).toBeTruthy();
  // The person scrolls up inside the thread: following stops, and growth no longer moves it.
  top = 600;
  fireEvent.wheel(scroller, { deltaY: -200 });
  fireEvent.scroll(scroller);
  expect(screen.getByText("detached")).toBeTruthy();
  scrollTo.mockClear();
  resize();
  frame();
  expect(scrollTo).not.toHaveBeenCalled();
  // A wheel on the page itself is not this thread's scroll.
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(screen.getByText("following")).toBeTruthy();
  fireEvent.wheel(window, { deltaY: -200 });
  expect(screen.getByText("following")).toBeTruthy();
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: "smooth" });
  expect(window.scrollTo).not.toHaveBeenCalled();
});
