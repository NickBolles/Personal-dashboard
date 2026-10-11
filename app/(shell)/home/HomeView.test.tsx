// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AssistCard, HomePayload, HomeSectionId, NextAction } from "@/lib/contracts";
import { HomeView } from "./HomeView";

const state = vi.hoisted(() => ({
  home: undefined as HomePayload | undefined,
  prefs: undefined as { timezone?: string; layout: { homeSections: { id: HomeSectionId; visible: boolean }[] } } | undefined,
}));
afterEach(() => {
  cleanup();
  state.prefs = undefined;
});
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === "home" ? state.home : state.prefs }) }));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => false }) }));
vi.mock("@/lib/client/idb", () => ({ kvGet: async () => undefined, kvSet: async () => undefined }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
vi.mock("@/components/chat/QuickCapture", () => ({ QuickCapture: () => null }));
vi.mock("@/components/actions/ActionCard", () => ({ ActionCard: () => null }));
vi.mock("@/components/home/AssistCard", () => ({
  AssistCard: ({ card, onTriage }: { card: AssistCard; onTriage?: (c: AssistCard) => void }) => <button onClick={() => onTriage?.(card)}>Review tasks</button>,
}));
vi.mock("@/components/home/TriageDialog", () => ({
  TriageDialog: ({ items, onClose, timezone }: { timezone?: string; items: { id: string; title: string }[]; onClose: () => void }) => (
    <div role="dialog" data-timezone={timezone}>
      {items.map((i) => (
        <p key={i.id}>{i.title}</p>
      ))}
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));
vi.mock("@/components/ui", () => ({
  useOnline: () => true,
  cx: (...values: unknown[]) => values.filter(Boolean).join(" "),
  Badge: ({ children }: ComponentProps<"span">) => <span>{children}</span>,
  Empty: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  Spinner: () => null,
  ErrorNote: () => null,
}));

it("preserves configured waiting/completed order relative to today/upcoming", () => {
  const item: NextAction = {
    id: "a",
    sourceId: "a",
    source: "todos",
    title: "Task",
    status: "open",
    priorityReason: "today",
    updatedAt: "2026-10-10T17:00:00Z",
    fetchedAt: "2026-10-10T17:00:00Z",
    staleAfter: "2026-10-11T17:00:00Z",
    href: "/todos",
  };
  state.home = {
    generatedAt: item.updatedAt,
    now: [],
    later: { laterToday: [item], upcoming: [item], waitingOn: [item], recentlyCompleted: [item] },
    glance: { homeExceptions: [] },
    sources: [],
  };
  state.prefs = { layout: { homeSections: ["waiting", "later_today", "completed", "upcoming"].map((id) => ({ id: id as HomeSectionId, visible: true })) } };
  render(<HomeView />);
  const headings = screen
    .getAllByRole("heading")
    .map((h) => h.textContent)
    .filter((t) => /Waiting on|Later today|Recently completed|Next two weeks/.test(t ?? ""));
  expect(headings).toEqual(["Waiting on (1)", "Later today· 1", "Recently completed (1)", "Next two weeks"]);
});

it("keeps the reviewed tasks and results dialog alive after refetch removes the suggestion", () => {
  const card: AssistCard = {
    id: "assist:overdue_triage",
    kind: "overdue_triage",
    category: "assist:overdue_triage",
    title: "Overdue tasks",
    body: "Three tasks",
    basis: "Todos",
    origin: "data",
    tone: "warn",
    why: [],
    provenance: { version: 1, fingerprint: "3-5", sources: ["todos"], generatedAt: "2026-10-10T17:00:00Z" },
    triage: { actionIds: ["todos:1"], items: [{ id: "todos:1", title: "Reviewed task", due: "2026-10-01" }] },
  };
  state.home = {
    generatedAt: "2026-10-10T17:00:00Z",
    now: [],
    later: { laterToday: [], upcoming: [], waitingOn: [], recentlyCompleted: [] },
    glance: { homeExceptions: [] },
    sources: [],
    assists: [card],
  };
  state.prefs = { timezone: "America/Chicago", layout: { homeSections: [] } };
  const view = render(<HomeView />);
  fireEvent.click(screen.getByRole("button", { name: "Review tasks" }));
  expect(screen.getByRole("dialog").textContent).toContain("Reviewed task");
  expect(screen.getByRole("dialog").getAttribute("data-timezone")).toBe("America/Chicago");
  state.home = { ...state.home, assists: [] };
  view.rerender(<HomeView />);
  expect(screen.queryByRole("button", { name: "Review tasks" })).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("Reviewed task");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
