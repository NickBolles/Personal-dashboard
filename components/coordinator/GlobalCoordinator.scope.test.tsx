// @vitest-environment jsdom
/**
 * The composer's chip ("About R-40", "Steer R-3") belongs to the draft it was set for. The host keeps the chip, so
 * the host is where it could outlive that draft: a quick action tapped on the collapsed tray, a ⌘K prompt, or simply
 * closing the sheet and coming back later. The owner hit the first one: an "About R-40" chip from an earlier tap
 * rode along with an unrelated quick action.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { COORDINATOR_PROMPT } from "@/lib/quick-actions";
import type { ComposeScope } from "@/lib/coordinator/compose";
import { GlobalCoordinator } from "./GlobalCoordinator";

vi.mock("next/navigation", () => ({
  usePathname: () => "/more",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
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
          pinned: false,
          agent: { routed: true, profile: "chiefofstaff", requested: "chiefofstaff" },
        };
      return {};
    }),
    post: vi.fn(async () => ({})),
  },
}));
const ABOUT_R40: ComposeScope = { kind: "ask", ref: "R-40", title: "Ledger import" };
let selectedKind: ComposeScope["kind"] = "ask";
// The thread, reduced to the host's side of the composer: what chip and draft it is handed, and the two things the
// owner does there (a row's Ask puts the chip in; typing changes the draft).
vi.mock("./CoordinatorThread", () => ({
  CoordinatorThread: (p: { scope?: ComposeScope | null; onScope?: (s: ComposeScope | null) => void; draft?: string; onDraft?: (t: string) => void }) => (
    <div>
      <output data-testid="chip">{p.scope?.ref ?? ""}</output>
      <output data-testid="draft">{p.draft ?? ""}</output>
      <button type="button" onClick={() => p.onScope?.({ ...ABOUT_R40, kind: selectedKind })}>
        Ask about R-40
      </button>
      <button type="button" onClick={() => p.onDraft?.("what changed in")}>
        Type some words
      </button>
    </div>
  ),
}));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({
  QuickActionChips: ({ onPrompt, variant }: { onPrompt: (text: string) => void; variant: string }) => (
    <button type="button" onClick={() => onPrompt("Momentum check")}>
      Quick action ({variant})
    </button>
  ),
}));
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
beforeEach(() => {
  selectedKind = "ask";
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
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

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GlobalCoordinator />
    </QueryClientProvider>,
  );
  // The tray's quick actions appear once the Chief of staff area has loaded.
  await screen.findByRole("button", { name: "Quick action (tray)" });
}
const openSheet = () => fireEvent.click(screen.getByRole("button", { name: "Chief of staff" }));
const closeSheet = () => fireEvent.click(screen.getByRole("button", { name: "Close Chief of staff sheet" }));
const chip = () => screen.getByTestId("chip").textContent;
const draft = () => screen.getByTestId("draft").textContent;
const askAboutR40 = () => fireEvent.click(screen.getByRole("button", { name: "Ask about R-40" }));
const typeWords = () => fireEvent.click(screen.getByRole("button", { name: "Type some words" }));

it("a quick action tapped on the tray starts its own message: a chip left from an earlier Ask does not ride along", async () => {
  await mount();
  openSheet();
  askAboutR40();
  typeWords();
  expect(chip()).toBe("R-40");
  closeSheet();
  // Words were typed, so the chip and the draft waited together. The quick action replaces that draft.
  fireEvent.click(screen.getByRole("button", { name: "Quick action (tray)" }));
  expect(draft()).toBe("Momentum check");
  expect(chip()).toBe("");
});

it("a prompt from the palette starts its own message too", async () => {
  await mount();
  openSheet();
  askAboutR40();
  typeWords();
  act(() => {
    window.dispatchEvent(new CustomEvent(COORDINATOR_PROMPT, { detail: { text: "Plan my week" } }));
  });
  expect(draft()).toBe("Plan my week");
  expect(chip()).toBe("");
});

it.each(["answer", "steer", "retry"] as const)("explicit Chief question clears an old %s scope while retaining draft text", async (kind) => {
  selectedKind = kind;
  await mount();
  openSheet();
  askAboutR40();
  typeWords();
  expect(chip()).toBe("R-40");
  act(() => {
    window.dispatchEvent(new CustomEvent(COORDINATOR_PROMPT, { detail: { text: "Plan my week", target: "chief" } }));
  });
  expect(draft()).toBe("what changed in\n\nPlan my week");
  expect(chip()).toBe("");
});

it("a chip with nothing typed after it does not wait for the next time the sheet is opened", async () => {
  await mount();
  openSheet();
  askAboutR40();
  expect(chip()).toBe("R-40");
  closeSheet();
  openSheet();
  expect(chip()).toBe("");
});

it("a chip with words typed after it is kept with its draft across closing the sheet", async () => {
  await mount();
  openSheet();
  askAboutR40();
  typeWords();
  closeSheet();
  openSheet();
  expect(chip()).toBe("R-40");
  expect(draft()).toBe("what changed in");
});
