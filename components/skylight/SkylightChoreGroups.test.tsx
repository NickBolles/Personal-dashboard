// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NextAction } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { localDate } from "@/lib/time";
import { SkylightChoreGroups, choreSections } from "./SkylightChoreGroups";
import { useSkylightWrite } from "./useSkylightWrite";
import { skylightWrites } from "./writeStore";

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useOnline: () => true,
  useToast: () => ({ toast: state.toast, announce: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => true }) }));

const TZ = "America/Chicago";
const NOW = Date.now();
const today = localDate(NOW, TZ);
const chore = (id: string, title: string, over: Partial<NextAction> = {}, time?: string): NextAction =>
  ({
    id,
    source: "skylight",
    sourceId: id,
    title,
    status: "open",
    priorityReason: "today",
    updatedAt: new Date(NOW).toISOString(),
    fetchedAt: new Date(NOW).toISOString(),
    staleAfter: new Date(NOW + 3_600_000).toISOString(),
    href: "https://app.ourskylight.com/",
    external: true,
    skylight: { kind: "chore", choreId: id, categoryId: null, startDate: today, ...(time ? { startTime: time } : {}) },
    ...over,
  }) as NextAction;

function Harness({ actions }: { actions: NextAction[] }) {
  const write = useSkylightWrite();
  return (
    <>
      <SkylightChoreGroups actions={actions} writable request={write.request} timezone={TZ} now={NOW} idPrefix="t" compact />
      {write.node}
    </>
  );
}
const renderWith = (actions: NextAction[]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <Harness actions={actions} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  skylightWrites.reset();
  vi.mocked(api.post).mockReset();
  state.toast.mockClear();
  // jsdom: reduced motion so settle timers run on the next tick.
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => cleanup());

it("buckets open chores with per-group progress, counting chores done today", () => {
  const sections = choreSections(
    [
      chore("a", "Morning dishes", {}, "08:00"),
      chore("b", "Morning bins", {
        status: "completed",
        skylight: { kind: "chore", choreId: "b", categoryId: null, startDate: today, startTime: "09:00", completedOn: today },
      }),
      chore("c", "Anytime laundry"),
    ],
    { now: NOW, timezone: TZ },
  );
  expect(sections.map((s) => [s.key, s.open.length, s.done.length])).toEqual([
    ["morning", 1, 1],
    ["anytime", 1, 0],
  ]);
});

it("completes from the row: pending shimmer → collapses → Done today, progress ticks, Undo restores", async () => {
  let finish!: (v: unknown) => void;
  vi.mocked(api.post)
    .mockImplementationOnce(() => new Promise((r) => (finish = r)))
    .mockResolvedValueOnce({ ok: true, message: "Undone" });
  renderWith([chore("a", "Lantern dishes", {}, "08:00"), chore("b", "Lantern bins", {}, "09:00")]);
  expect(screen.getByRole("img", { name: "Morning: 0 of 2 done" })).toBeDefined();
  fireEvent.click(screen.getByRole("checkbox", { name: "Done: Lantern dishes" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  const row = () => screen.getByRole("checkbox", { name: "Done: Lantern dishes" }).closest(".sk-row") as HTMLElement;
  expect(row().dataset.phase).toBe("pending");
  expect(row().getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("checkbox", { name: "Done: Lantern dishes" }).getAttribute("aria-checked")).toBe("true");
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await act(async () => finish({ ok: true, writeId: "w1", undoable: true, message: "ok" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Morning: 1 of 2 done" })).toBeDefined());
  expect(screen.getByTestId("t-done").textContent).toContain("Lantern dishes");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Morning: 0 of 2 done" })).toBeDefined());
  expect(row().dataset.phase).toBe("restored");
  expect(screen.queryByTestId("t-done")).toBeNull();
});

it("rolls back with a shake on error and keeps Skylight's reason in the sheet", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Skylight is read-only"));
  renderWith([chore("a", "Lantern dishes", {}, "08:00")]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Done: Lantern dishes" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Skylight is read-only"));
  const box = screen.getByRole("checkbox", { name: "Done: Lantern dishes" });
  await waitFor(() => expect((box.closest(".sk-row") as HTMLElement).dataset.phase).toBeUndefined());
  expect(box.getAttribute("aria-checked")).toBe("false");
});

it("celebrates once when the last open chore of the day is done", async () => {
  vi.mocked(api.post).mockResolvedValueOnce({ ok: true, writeId: "w2", undoable: true, message: "ok" });
  renderWith([chore("a", "Lantern dishes", {}, "08:00")]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Done: Lantern dishes" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.getByText("All of today’s chores are done")).toBeDefined());
  expect(screen.getByText("All of today’s chores are done").className).toContain("sk-celebrate");
});

it("swipe right on touch completes through the same confirm card", () => {
  renderWith([chore("a", "Lantern dishes", {}, "08:00")]);
  const row = screen.getByRole("checkbox", { name: "Done: Lantern dishes" }).closest(".sk-row") as HTMLElement;
  const ev = (type: string, x: number) =>
    fireEvent(row, Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }), { pointerType: "touch", pointerId: 1, isPrimary: true }));
  ev("pointerdown", 10);
  ev("pointermove", 40);
  ev("pointermove", 100);
  ev("pointerup", 100);
  expect(screen.getByRole("dialog").textContent).toContain("Lantern dishes");
  expect(api.post).not.toHaveBeenCalled();
});

it("Hermes-mode chores (no Skylight ref) stay read-only", () => {
  renderWith([chore("h", "Hermes chore", { skylight: undefined })]);
  expect(screen.queryByRole("checkbox", { name: "Done: Hermes chore" })).toBeNull();
});
