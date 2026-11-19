// @vitest-environment jsdom
/**
 * Expand: on /chief the shell's one Chief of staff panel is the page. It is the same panel (so the thread, its draft
 * and its run stream carry over), at full size; wide screens show the conversation with Needs you / Activity beside it.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CHIEF_PATH, GlobalCoordinator } from "./GlobalCoordinator";

const nav = { path: "/more", push: vi.fn(), back: vi.fn() };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push, back: nav.back }),
}));
vi.mock("@/lib/client/api", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/api/coordinator/decisions")) return { decisions: [], counts: { open: 0, deferred: 0 } };
      if (path === "/api/coordinator/runs")
        return { runs: [], events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } };
      if (path === "/api/work/coordinator/global")
        return {
          scope: "global",
          area: { id: "area-1", title: "Portfolio" },
          sessionId: "s-1",
          excluded: false,
          pinned: true,
          agent: { routed: true, profile: "chiefofstaff", requested: "chiefofstaff" },
        };
      return {};
    }),
    post: vi.fn(async () => ({})),
  },
}));
// The thread, reduced to what the host hands it: enough to see that it is one mounted thread, told when it is the page.
let threadMounts = 0;
vi.mock("./CoordinatorThread", async () => {
  const { useEffect } = await import("react");
  return {
    CoordinatorThread: (p: { standalone?: boolean; context?: unknown }) => {
      useEffect(() => {
        threadMounts += 1;
      }, []);
      return (
        <div data-testid="thread" data-standalone={String(!!p.standalone)} data-context={String(!!p.context)}>
          The conversation
        </div>
      );
    },
  };
});
vi.mock("./needs/NeedsPanel", () => ({ NeedsPanel: () => <div data-testid="needs-panel">Needs you list</div> }));
vi.mock("./running/RunningPanel", () => ({ RunningPanel: () => <div data-testid="running-panel">Activity list</div> }));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({ QuickActionChips: () => null }));
vi.mock("@/components/agents/WhileAwayCard", () => ({ WhileAwayCard: () => null }));
vi.mock("./useCoordinatorThings", () => ({
  useCoordinatorThings: () => ({
    things: { needsYou: 0, decisions: [], running: [], failing: [], changes: [], doneUnseen: 0 },
    line: { text: "All quiet", tone: "neutral", dot: null },
    markSeen: vi.fn(),
    error: null,
  }),
}));

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
let wide = true;
beforeEach(() => {
  nav.path = "/more";
  nav.push.mockClear();
  nav.back.mockClear();
  threadMounts = 0;
  wide = true;
  vi.stubGlobal("matchMedia", () => ({ matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of [
    ["showModal", originalShow],
    ["close", originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <GlobalCoordinator />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()) };
}
const rail = () => screen.getByRole("complementary", { name: "Chief of staff" });

it("the rail offers Expand, which goes to the Chief of staff's own address", async () => {
  mount();
  await screen.findByTestId("thread");
  expect(rail().hasAttribute("data-full")).toBe(false);
  fireEvent.click(within(rail()).getByRole("button", { name: "Expand Chief of staff" }));
  expect(nav.push).toHaveBeenCalledExactlyOnceWith(CHIEF_PATH);
});

it("wide: expanding keeps the one mounted thread, shows it beside Needs you and Activity, and leaves on close", async () => {
  const view = mount();
  await screen.findByTestId("thread");
  expect(
    within(rail())
      .getAllByRole("tab")
      .map((t) => t.textContent),
  ).toEqual(["Chat", "Needs you", "Activity"]);
  nav.path = CHIEF_PATH;
  view.rerender();
  // The same panel, not a second one: the thread was mounted once and is still the one on screen.
  expect(threadMounts).toBe(1);
  expect(rail().getAttribute("data-full")).toBe("true");
  expect(rail().style.width).toBe("");
  // The conversation is always there; the tabs now choose the side column only.
  expect(
    within(rail())
      .getAllByRole("tab")
      .map((t) => t.textContent),
  ).toEqual(["Needs you", "Activity"]);
  const conversation = within(rail()).getByRole("region", { name: "Conversation" });
  expect(within(conversation).getByTestId("thread")).toBeTruthy();
  expect(within(rail()).getByTestId("needs-panel")).toBeTruthy();
  fireEvent.click(within(rail()).getByRole("tab", { name: "Activity" }));
  expect(within(rail()).getByTestId("running-panel")).toBeTruthy();
  expect(within(rail()).queryByTestId("needs-panel")).toBeNull();
  expect(conversation.hidden).toBe(false);
  // It is the page: no "Viewing: …" context about another page, no Expand, no resizer to drag.
  expect(screen.getByTestId("thread").getAttribute("data-standalone")).toBe("true");
  expect(screen.getByTestId("thread").getAttribute("data-context")).toBe("false");
  expect(within(rail()).queryByRole("button", { name: "Expand Chief of staff" })).toBeNull();
  expect(within(rail()).queryByRole("separator", { name: "Resize Chief of staff" })).toBeNull();
  expect(rail().querySelector<HTMLElement>(".gc-resizer")!.hidden).toBe(true);
  // Closing leaves the full view instead of collapsing a rail.
  // Expanded from a page of this app: Leave goes back to it.
  nav.push.mockClear();
  fireEvent.click(within(rail()).getByRole("button", { name: "Leave full view" }));
  expect(nav.back).toHaveBeenCalledOnce();
  expect(nav.push).not.toHaveBeenCalled();
});

it("opened directly, Leave full view goes to Today: what is behind /chief in the browser's history is not the app's to return to", async () => {
  nav.path = CHIEF_PATH;
  mount();
  await screen.findByTestId("thread");
  fireEvent.click(within(rail()).getByRole("button", { name: "Leave full view" }));
  expect(nav.push).toHaveBeenCalledExactlyOnceWith("/home");
  expect(nav.back).not.toHaveBeenCalled();
});

it("phone: on /chief the sheet is the page (open, full height, no grab bar to drag), and closing it leaves", async () => {
  wide = false;
  nav.path = CHIEF_PATH;
  mount();
  const sheet = await screen.findByRole("dialog", { name: "Chief of staff" });
  expect(sheet.getAttribute("data-full")).toBe("true");
  expect(sheet.hasAttribute("open")).toBe(true);
  // Below the split width the tabs stay tabs.
  expect(
    within(sheet)
      .getAllByRole("tab")
      .map((t) => t.textContent),
  ).toEqual(["Chat", "Needs you", "Activity"]);
  fireEvent.click(within(sheet).getByRole("button", { name: "Leave full view" }));
  expect(nav.push).toHaveBeenCalledExactlyOnceWith("/home");
  expect(nav.back).not.toHaveBeenCalled();
});

it("phone: leaving /chief for another page closes the sheet again", async () => {
  wide = false;
  nav.path = CHIEF_PATH;
  const view = mount();
  await screen.findByRole("dialog", { name: "Chief of staff" });
  nav.path = "/todos";
  view.rerender();
  expect(screen.queryByRole("dialog")).toBeNull();
});
