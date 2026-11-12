// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CardMenu, useCardMenu } from "./CardMenu";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function Card({ onCopy }: { onCopy: () => void }) {
  const menu = useCardMenu();
  const [ticks, setTicks] = useState(0);
  return (
    <article data-testid="card" onContextMenu={menu.onContextMenu}>
      {/* stands in for the card's clock: a re-render while the menu is open */}
      <button type="button" onClick={() => setTicks((n) => n + 1)}>
        Head {ticks}
      </button>
      <CardMenu at={menu.at} label="Actions" items={[{ label: "Copy", onSelect: onCopy }]} onClose={menu.close} />
    </article>
  );
}

it("a card that re-renders under its open menu does not scroll it into view again, and closing gives focus back", async () => {
  const scrolled = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrolled });
  const onCopy = vi.fn();
  render(<Card onCopy={onCopy} />);
  const head = screen.getByRole("button", { name: /^Head/ });
  head.focus();
  // the keyboard's Menu key: a contextmenu event with no pointer position
  fireEvent.contextMenu(screen.getByTestId("card"), { clientX: 0, clientY: 0 });
  const item = screen.getByRole("menuitem", { name: "Copy" });
  expect(document.activeElement).toBe(item);
  expect(scrolled).toHaveBeenCalledTimes(1);
  fireEvent.click(head);
  fireEvent.click(head);
  expect(screen.getByRole("button", { name: "Head 2" })).toBeTruthy();
  expect(scrolled).toHaveBeenCalledTimes(1);
  // Escape closes it and focus goes back to where it was, not to the page
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(head));
  expect(onCopy).not.toHaveBeenCalled();
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
