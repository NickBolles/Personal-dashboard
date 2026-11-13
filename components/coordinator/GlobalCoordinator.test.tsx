// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPEN_PALETTE_EVENT } from "@/components/navigation/commands";
import { QUICK_ACTION_MANAGE } from "@/lib/quick-actions";
import { GlobalCoordinator } from "./GlobalCoordinator";

vi.mock("next/navigation", () => ({ usePathname: () => "/more", useSearchParams: () => new URLSearchParams() }));
// No Chief of staff area, no decisions, no runs: these tests are about the sheet and the tray themselves.
vi.mock("@/lib/client/api", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/api/coordinator/decisions")) return { decisions: [], counts: { open: 0, deferred: 0 } };
      if (path === "/api/coordinator/runs")
        return { runs: [], events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } };
      return { area: null };
    }),
    post: vi.fn(async () => ({})),
  },
}));
vi.mock("./CoordinatorThread", () => ({ CoordinatorThread: () => null }));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({ QuickActionChips: () => null }));
vi.mock("./useCoordinatorThings", () => ({
  useCoordinatorThings: () => ({
    things: { needsYou: 0, decisions: [], running: [], failing: [], changes: [], doneUnseen: 0 },
    line: { text: "All quiet", tone: "neutral", dot: null },
    markSeen: vi.fn(),
    error: null,
  }),
}));
const close = vi.fn(function (this: HTMLDialogElement) {
  this.removeAttribute("open");
});
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: close });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  close.mockClear();
  for (const [key, descriptor] of [
    ["showModal", originalShow],
    ["close", originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
});
it.each([OPEN_PALETTE_EVENT, QUICK_ACTION_MANAGE])("dismisses the native phone sheet synchronously on %s", (event) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GlobalCoordinator />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Chief of staff" }));
  const sheet = screen.getByRole("dialog", { name: "Chief of staff" });
  expect(sheet.hasAttribute("open")).toBe(true);
  act(() => {
    window.dispatchEvent(new Event(event));
    expect(sheet.hasAttribute("open")).toBe(false);
  });
  expect(close).toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

// ---- The phone sheet has one height: its grab bar (and header) only close it ---------------------------------------
function openSheet() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <GlobalCoordinator />
    </QueryClientProvider>,
  );
  const tray = screen.getByRole("button", { name: "Chief of staff" });
  const open = () => {
    fireEvent.click(tray);
    const sheet = screen.getByRole("dialog", { name: "Chief of staff" });
    // jsdom lays nothing out: give the sheet a height so a drag has something to measure against
    vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue({ top: 168, bottom: 768, left: 0, right: 368, width: 368, height: 600, x: 0, y: 168 } as DOMRect);
    return sheet;
  };
  return { ...view, open, sheet: open() };
}
const grabBar = () => screen.getByRole("button", { name: "Close Chief of staff sheet" });
const isOpen = () => !!screen.queryByRole("dialog");
/** A slow drag (no flick): press, move in steps of at most 60 px 400 ms apart, release. */
function drag(on: HTMLElement, by: number) {
  let t = 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => (t += 400));
  const at = (clientY: number) => ({ pointerId: 1, pointerType: "touch", button: 0, clientY });
  fireEvent.pointerDown(on, at(200));
  const steps = Math.max(1, Math.ceil(Math.abs(by) / 60));
  for (let i = 1; i <= steps; i++) fireEvent.pointerMove(on, at(200 + (by * i) / steps));
  fireEvent.pointerUp(on, at(200 + by));
  clock.mockRestore();
}

it("the phone sheet has a grab bar that says what a tap does, and the header close control keeps its name", () => {
  const { sheet } = openSheet();
  // one height: the bar is not a height switch
  expect(screen.queryByRole("button", { name: /^(Full|Half) height$/ })).toBeNull();
  expect(grabBar().title).toBe("Drag down to close");
  expect(sheet.firstElementChild?.contains(grabBar())).toBe(true);
  const close = screen.getByRole("button", { name: "Close Chief of staff" });
  expect(close.hasAttribute("data-gc-close")).toBe(true);
  // a chevron, not a cross: the sheet collapses back into the tray
  expect(close.querySelector("svg")).toBeTruthy();
  fireEvent.click(close);
  expect(isOpen()).toBe(false);
});

it("a tap on the grab bar closes the sheet: by touch, by a keyboard or screen-reader click, and with Arrow down", () => {
  const { open } = openSheet();
  // a press that barely moves is a tap, not a drag
  fireEvent.pointerDown(grabBar(), { pointerId: 1, pointerType: "touch", clientY: 200 });
  fireEvent.pointerMove(grabBar(), { pointerId: 1, pointerType: "touch", clientY: 203 });
  fireEvent.pointerUp(grabBar(), { pointerId: 1, pointerType: "touch", clientY: 203 });
  expect(isOpen()).toBe(false);
  open();
  fireEvent.click(grabBar());
  expect(isOpen()).toBe(false);
  open();
  // there is no taller height to go to: Arrow up does nothing, Arrow down closes
  fireEvent.keyDown(grabBar(), { key: "ArrowUp" });
  expect(isOpen()).toBe(true);
  fireEvent.keyDown(grabBar(), { key: "ArrowDown" });
  expect(isOpen()).toBe(false);
  // the tray is still there to open it again
  open();
  expect(isOpen()).toBe(true);
});

it("dragging the grab bar down closes the sheet; a small dip or a drag up leaves it open and leaves no inline size behind", async () => {
  const { sheet } = openSheet();
  drag(grabBar(), 60);
  expect(isOpen()).toBe(true);
  expect(sheet.style.height).toBe("");
  expect(sheet.style.transform).toBe("");
  expect(sheet.hasAttribute("data-dragging")).toBe(false);
  drag(grabBar(), -200);
  expect(isOpen()).toBe(true);
  expect(sheet.style.height).toBe("");
  expect(sheet.style.transform).toBe("");
  // while it is dragged down it follows the finger (it slides, it does not shrink)
  fireEvent.pointerDown(grabBar(), { pointerId: 2, pointerType: "touch", button: 0, clientY: 200 });
  fireEvent.pointerMove(grabBar(), { pointerId: 2, pointerType: "touch", button: 0, clientY: 320 });
  expect(sheet.hasAttribute("data-dragging")).toBe(true);
  expect(sheet.style.transform).toBe("translateY(120px)");
  fireEvent.pointerCancel(grabBar(), { pointerId: 2, pointerType: "touch", button: 0, clientY: 320 });
  expect(isOpen()).toBe(true);
  expect(sheet.style.transform).toBe("");
  drag(grabBar(), 400);
  await vi.waitFor(() => expect(isOpen()).toBe(false));
});

it("the sheet's header drags it closed too, but a press on the close control in it is never a drag", async () => {
  const { sheet } = openSheet();
  const header = sheet.querySelector<HTMLElement>("header.gc-head")!;
  expect(header.hasAttribute("data-sheet-drag")).toBe(true);
  const close = screen.getByRole("button", { name: "Close Chief of staff" });
  expect(close.hasAttribute("data-sheet-nodrag")).toBe(true);
  drag(close, 400);
  expect(sheet.style.transform).toBe("");
  expect(isOpen()).toBe(true);
  drag(screen.getByRole("heading", { name: "Chief of staff" }), 400);
  await vi.waitFor(() => expect(isOpen()).toBe(false));
});

it("a sheet that was dragged closed can be dragged closed again the next time it is opened", async () => {
  const { open } = openSheet();
  drag(grabBar(), 400);
  await vi.waitFor(() => expect(isOpen()).toBe(false));
  const again = open();
  // the reopened sheet is a new element at its resting place
  expect(again.style.transform).toBe("");
  drag(grabBar(), 400);
  await vi.waitFor(() => expect(isOpen()).toBe(false));
});

it("with reduced motion a drag closes the sheet at once, without the slide", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  openSheet();
  drag(grabBar(), 400);
  expect(isOpen()).toBe(false);
});

it("a long press on the phone tray goes straight to a tab", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GlobalCoordinator />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(screen.getByRole("button", { name: "Chief of staff" }), { clientX: 40, clientY: 700 });
  const menu = screen.getByRole("menu", { name: "Open Chief of staff at" });
  expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent)).toEqual(["Chat", "Needs you", "Activity"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Activity" }));
  expect(screen.queryByRole("menu")).toBeNull();
  const sheet = screen.getByRole("dialog", { name: "Chief of staff" });
  expect(sheet.hasAttribute("open")).toBe(true);
  expect(screen.getByRole("tab", { name: /^Activity/ }).getAttribute("aria-selected")).toBe("true");
});
