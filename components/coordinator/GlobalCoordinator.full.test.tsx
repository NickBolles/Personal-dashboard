// @vitest-environment jsdom
/**
 * Expand: on /chief the shell's one Chief of staff panel is the page. It is the same panel (so the thread, its draft
 * and its run stream carry over), at full size; wide screens show the conversation with Tasks beside it.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { COORDINATOR_PINNED_THREAD, OPEN_PALETTE_EVENT, OVERLAY_CLOSED_EVENT } from "@/components/navigation/commands";
import { COORDINATOR_PROMPT, QUICK_ACTION_MANAGE } from "@/lib/quick-actions";
import { CHIEF_PATH, GlobalCoordinator } from "./GlobalCoordinator";

const nav = { path: "/more", search: "", push: vi.fn(), back: vi.fn(), replace: vi.fn() };
const router = { push: nav.push, back: nav.back, replace: nav.replace };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => router,
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
    CoordinatorThread: (p: {
      standalone?: boolean;
      draft?: string;
      onDraft?: (value: string) => void;
      context?: unknown;
      selection?: { sessionId: string | null; fresh: boolean };
      onSelection?: (next: { sessionId: string | null; fresh: boolean }) => void;
    }) => {
      useEffect(() => {
        threadMounts += 1;
      }, []);
      return (
        <div data-testid="thread" data-standalone={String(!!p.standalone)} data-context={String(!!p.context)} data-on={p.selection?.sessionId ?? "chief"}>
          The conversation
          <output data-testid="thread-draft">{p.draft}</output>
          <button type="button" onClick={() => p.onDraft?.("Existing draft")}>
            Keep a draft
          </button>
          <button type="button" onClick={() => p.onSelection?.({ sessionId: "earlier-thread", fresh: false })}>
            Open an earlier thread
          </button>
        </div>
      );
    },
  };
});
vi.mock("./needs/NeedsPanel", () => ({ NeedsPanel: () => <div data-testid="needs-panel">Needs you list</div> }));
vi.mock("@/components/tasks/TaskList", () => ({ TaskList: () => <div data-testid="task-list">Task list</div> }));
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
  nav.search = "";
  nav.push.mockClear();
  nav.back.mockClear();
  nav.replace.mockClear();
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

it("explicit Chief Ask keeps the pinned destination, page context and draft even with an area pane open", async () => {
  mount();
  await screen.findByTestId("thread");
  fireEvent.click(screen.getByRole("button", { name: "Keep a draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Open an earlier thread" }));
  expect(screen.getByTestId("thread").getAttribute("data-on")).toBe("earlier-thread");
  const pane = document.createElement("div");
  pane.dataset.testid = "coordinator-pane";
  document.body.append(pane);
  try {
    act(() => void window.dispatchEvent(new CustomEvent(COORDINATOR_PROMPT, { detail: { text: "New question", target: "chief" } })));
    expect(screen.getByTestId("thread").getAttribute("data-on")).toBe("chief");
    expect(screen.getByTestId("thread-draft").textContent).toBe("Existing draft\n\nNew question");
    expect(screen.getByTestId("thread").getAttribute("data-context")).toBe("true");
    expect(nav.push).not.toHaveBeenCalled();
  } finally {
    pane.remove();
  }
});

it("the rail offers Expand, which goes to the Chief of staff's own address", async () => {
  mount();
  await screen.findByTestId("thread");
  expect(rail().hasAttribute("data-full")).toBe(false);
  fireEvent.click(within(rail()).getByRole("button", { name: "Expand Chief of staff" }));
  expect(nav.push).toHaveBeenCalledExactlyOnceWith(CHIEF_PATH);
});

it("wide: expanding keeps the one mounted thread, shows it beside Tasks, and leaves on close", async () => {
  const view = mount();
  await screen.findByTestId("thread");
  expect(
    within(rail())
      .getAllByRole("tab")
      .map((t) => t.textContent),
  ).toEqual(["Chat", "Tasks"]);
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
  ).toEqual(["Tasks"]);
  const conversation = within(rail()).getByRole("region", { name: "Conversation" });
  expect(within(conversation).getByTestId("thread")).toBeTruthy();
  // The side column is the task list. No decision was opened, so no answer card is drawn above it.
  expect(within(rail()).getByTestId("task-list")).toBeTruthy();
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
  ).toEqual(["Chat", "Tasks"]);
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

// Search and Manage quick actions need the native modal sheet out of the way. On /chief the sheet is the page, so it
// only steps aside: the same mounted thread is back when the overlay closes.
it.each([OPEN_PALETTE_EVENT, QUICK_ACTION_MANAGE])(
  "phone: on /chief the sheet steps aside for %s and comes back, still the one mounted thread",
  async (event) => {
    wide = false;
    nav.path = CHIEF_PATH;
    mount();
    const sheet = await screen.findByRole("dialog", { name: "Chief of staff" });
    await screen.findByTestId("thread");
    expect(threadMounts).toBe(1);
    act(() => void window.dispatchEvent(new Event(event)));
    expect(sheet.hasAttribute("open")).toBe(false);
    expect(sheet.isConnected).toBe(true);
    expect(screen.getByTestId("thread")).toBeTruthy();
    act(() => void window.dispatchEvent(new Event(OVERLAY_CLOSED_EVENT)));
    expect(sheet.hasAttribute("open")).toBe(true);
    expect(threadMounts).toBe(1);
  },
);

it("phone: on any other page the sheet still closes for an overlay and does not come back by itself", async () => {
  wide = false;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Chief of staff/ }));
  expect(screen.getByRole("dialog", { name: "Chief of staff" }).hasAttribute("open")).toBe(true);
  act(() => void window.dispatchEvent(new Event(QUICK_ACTION_MANAGE)));
  expect(screen.queryByRole("dialog", { name: "Chief of staff" })).toBeNull();
  act(() => void window.dispatchEvent(new Event(OVERLAY_CLOSED_EVENT)));
  expect(screen.queryByRole("dialog", { name: "Chief of staff" })).toBeNull();
});

it("/chief?thread=pinned asks the panel for the pinned thread, shows the conversation and cleans the address", async () => {
  const asked = vi.fn();
  window.addEventListener(COORDINATOR_PINNED_THREAD, asked);
  try {
    wide = false;
    nav.path = CHIEF_PATH;
    nav.search = "thread=pinned";
    mount();
    const sheet = await screen.findByRole("dialog", { name: "Chief of staff" });
    expect(asked).toHaveBeenCalled();
    expect(nav.replace).toHaveBeenCalledWith(CHIEF_PATH);
    expect(within(sheet).getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
  } finally {
    window.removeEventListener(COORDINATOR_PINNED_THREAD, asked);
  }
});

it("plain /chief (Expand) asks for no thread: the panel stays on the one it is showing", async () => {
  const asked = vi.fn();
  window.addEventListener(COORDINATOR_PINNED_THREAD, asked);
  try {
    nav.path = CHIEF_PATH;
    mount();
    await screen.findByTestId("thread");
    expect(asked).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(COORDINATOR_PINNED_THREAD, asked);
  }
});

it("a message link through the redirect keeps its target: the address becomes /chief#msg-<id>", async () => {
  window.history.replaceState(null, "", "/chief?thread=pinned#msg-a%201");
  try {
    nav.path = CHIEF_PATH;
    nav.search = "thread=pinned";
    mount();
    await screen.findByTestId("thread");
    expect(nav.replace).toHaveBeenCalledWith(CHIEF_PATH + "#msg-a%201");
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

// The draft is kept by the shell, and the phone sheet unmounts the thread when it closes. The thread the draft was
// written in is kept with it, or the draft would come back in a different conversation.
it("phone: closing the sheet (or leaving the full view) and opening it again is still on the thread that was open", async () => {
  wide = false;
  mount();
  const openSheet = async () => fireEvent.click(await screen.findByRole("button", { name: /Chief of staff/ }));
  await openSheet();
  expect((await screen.findByTestId("thread")).getAttribute("data-on")).toBe("chief");
  fireEvent.click(screen.getByRole("button", { name: "Open an earlier thread" }));
  expect(screen.getByTestId("thread").getAttribute("data-on")).toBe("earlier-thread");
  fireEvent.click(screen.getByRole("button", { name: "Close Chief of staff" }));
  expect(screen.queryByTestId("thread")).toBeNull();
  await openSheet();
  expect(threadMounts).toBe(2);
  expect(screen.getByTestId("thread").getAttribute("data-on")).toBe("earlier-thread");
});
