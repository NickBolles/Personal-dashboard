// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPEN_PALETTE_EVENT } from "@/components/navigation/commands";
import { QUICK_ACTION_MANAGE } from "@/lib/quick-actions";
import { GlobalCoordinator } from "./GlobalCoordinator";

vi.mock("next/navigation", () => ({ usePathname: () => "/more", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/client/api", () => ({ api: { get: vi.fn().mockResolvedValue({ area: null }) } }));
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
