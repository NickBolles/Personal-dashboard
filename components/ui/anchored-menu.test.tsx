// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnchoredMenu, MenuButton, useAnchoredMenu } from "./AnchoredMenu";

// jsdom has no PointerEvent: without it pointerType never reaches the handlers.
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PointerEventShim extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: PointerEventShim });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Card({ onCopy, enabled = true }: { onCopy: () => void; enabled?: boolean }) {
  const menu = useAnchoredMenu({ enabled });
  const [ticks, setTicks] = useState(0);
  return (
    <article data-testid="card" {...menu.surfaceProps}>
      {/* stands in for the card's clock: a re-render while the menu is open */}
      <button type="button" onClick={() => setTicks((n) => n + 1)}>
        Head {ticks}
      </button>
      <MenuButton menu={menu} label="Actions for R-1" />
      <AnchoredMenu
        menu={menu}
        label="Actions"
        items={[{ label: "Copy", onSelect: onCopy }, { label: "Review D-12 · a long question that wraps instead of truncating" }]}
      />
    </article>
  );
}

it("the ⋯ trigger opens the menu, Esc closes it and focus returns to the trigger", async () => {
  const onCopy = vi.fn();
  render(<Card onCopy={onCopy} />);
  const trigger = screen.getByRole("button", { name: "Actions for R-1" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.focus();
  fireEvent.click(trigger);
  const item = screen.getByRole("menuitem", { name: "Copy" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(item);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(onCopy).not.toHaveBeenCalled();
});

it("Menu key on a focused control: re-renders keep it open, closing returns focus to that control", async () => {
  render(<Card onCopy={() => undefined} />);
  const head = screen.getByRole("button", { name: /^Head/ });
  head.focus();
  fireEvent.contextMenu(screen.getByTestId("card"), { clientX: 0, clientY: 0 });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Copy" }));
  fireEvent.click(head);
  fireEvent.click(head);
  expect(screen.getByRole("button", { name: "Head 2" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(head));
});

it("a right-click with nothing focused returns focus to the card's ⋯ trigger, not the page", async () => {
  const onCopy = vi.fn();
  render(<Card onCopy={onCopy} />);
  fireEvent.contextMenu(screen.getByTestId("card"), { clientX: 30, clientY: 40 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for R-1" })));
});

it("a tap outside closes the menu without choosing anything", () => {
  const onCopy = vi.fn();
  render(<Card onCopy={onCopy} />);
  fireEvent.contextMenu(screen.getByTestId("card"), { clientX: 30, clientY: 40 });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onCopy).not.toHaveBeenCalled();
});

it("a long press on touch opens it, and the lift is not a tap on what was under the finger", () => {
  vi.useFakeTimers();
  render(<Card onCopy={() => undefined} />);
  const head = screen.getByRole("button", { name: /^Head/ });
  fireEvent.pointerDown(head, { pointerType: "touch", clientX: 20, clientY: 20 });
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.pointerUp(head, { pointerType: "touch" });
  fireEvent.click(head);
  expect(screen.getByRole("button", { name: "Head 0" })).toBeTruthy();
});

it("a touch that moves (a scroll) is not a long press", () => {
  vi.useFakeTimers();
  render(<Card onCopy={() => undefined} />);
  const head = screen.getByRole("button", { name: /^Head/ });
  fireEvent.pointerDown(head, { pointerType: "touch", clientX: 20, clientY: 20 });
  fireEvent.pointerMove(head, { pointerType: "touch", clientX: 20, clientY: 60 });
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(screen.queryByRole("menu")).toBeNull();
});

it("disabled: no trigger and the browser's own context menu stays", () => {
  render(<Card onCopy={() => undefined} enabled={false} />);
  expect(screen.queryByRole("button", { name: "Actions for R-1" })).toBeNull();
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  screen.getByTestId("card").dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("a viewport resize closes the menu (no throw on the window target)", () => {
  render(<Card onCopy={() => undefined} />);
  fireEvent.contextMenu(screen.getByTestId("card"), { clientX: 30, clientY: 40 });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("a page scroll that was already under way when the menu opened does not close it; a later one does", () => {
  let now = 1_000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    render(<Card onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for R-1" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    // the scroll that brought the trigger into view is delivered a frame after the tap
    now += 16;
    fireEvent.scroll(document);
    expect(screen.getByRole("menu")).toBeTruthy();
    // scrolling inside the menu never closes it
    now += 2_000;
    fireEvent.scroll(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
    // scrolling the page under an open menu does
    fireEvent.scroll(document);
    expect(screen.queryByRole("menu")).toBeNull();
  } finally {
    clock.mockRestore();
  }
});
