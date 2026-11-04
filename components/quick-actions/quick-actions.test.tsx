// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QuickAction } from "@/lib/quick-actions";
import { QUICK_ACTION_MANAGE } from "@/lib/quick-actions";
import { QuickActionChips } from "./QuickActionChips";
import { ProposedQuickActions } from "./ProposedQuickActions";
import { ManageQuickActions } from "./ManageQuickActions";

const mocks = vi.hoisted(() => ({ rows: [] as QuickAction[], mutate: vi.fn() }));
vi.mock("./useQuickActions", () => ({
  useQuickActions: () => ({ data: { actions: mocks.rows }, isLoading: false, error: null }),
  useQuickActionWrite: () => ({ write: { isPending: false, mutate: mocks.mutate }, undo: { isPending: false, mutate: vi.fn() }, undoId: null }),
}));
const row = (id: string, patch: Partial<QuickAction> = {}): QuickAction => ({
  id,
  userId: "owner",
  label: id,
  prompt: `Prompt ${id}`,
  scope: "global",
  pinned: false,
  sortOrder: 0,
  status: "active",
  source: "owner",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...patch,
});
beforeEach(() => {
  mocks.rows = [];
  mocks.mutate.mockReset();
});
afterEach(cleanup);

it("chips only fill: type=button prevents a containing composer form from submitting", () => {
  mocks.rows = [row("global"), row("area", { scope: "area:workshop", prompt: "Catch {area}" }), row("hidden", { status: "proposed" })];
  const fill = vi.fn();
  const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
  render(
    <form onSubmit={submit}>
      <QuickActionChips variant="row" context={{ areaId: "workshop", areaTitle: "Workshop" }} onPrompt={fill} />
    </form>,
  );
  fireEvent.click(screen.getByRole("button", { name: "area" }));
  expect(fill).toHaveBeenCalledExactlyOnceWith("Catch Workshop");
  expect(submit).not.toHaveBeenCalled();
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "hidden" })).toBeNull();
  const event = vi.fn();
  window.addEventListener(QUICK_ACTION_MANAGE, event);
  fireEvent.click(screen.getByRole("button", { name: "Manage quick actions" }));
  expect(event).toHaveBeenCalledOnce();
  window.removeEventListener(QUICK_ACTION_MANAGE, event);
});
it("proposal stays pending until explicit Add, passing the owner's inline edits only to accept", () => {
  mocks.rows = [row("Nebulark pending", { status: "proposed", source: "agent:chief" })];
  render(<ProposedQuickActions />);
  expect(mocks.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Proposed quick action prompt"), { target: { value: "Owner prompt" } });
  expect(mocks.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
    path: "/api/quick-actions/Nebulark pending/accept",
    body: { label: "Nebulark pending", prompt: "Owner prompt" },
    message: "Added",
  });
});
it("Manage keeps editor focus on rerender, supports keyboard reorder, Escape and focus return", () => {
  mocks.rows = [row("One"), row("Two", { sortOrder: 1 })];
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const close = vi.fn();
  const view = render(<ManageQuickActions open onClose={close} context={{ areaId: "workshop", path: "/areas" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Move up Two" }));
  expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({ path: "/api/quick-actions/reorder", body: { ids: ["Two", "One"] }, message: "Reordered" });
  fireEvent.click(screen.getByRole("button", { name: "Edit One" }));
  const prompt = screen.getByLabelText("Quick action prompt");
  prompt.focus();
  fireEvent.change(prompt, { target: { value: "Still typing" } });
  view.rerender(<ManageQuickActions open onClose={() => close()} context={{ areaId: "workshop", path: "/areas" }} />);
  expect(document.activeElement).toBe(prompt);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  view.rerender(<ManageQuickActions open={false} onClose={close} />);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
