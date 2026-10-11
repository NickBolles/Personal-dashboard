// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { selectAttention } from "@/server/ranking/attention";
import type { NextAction } from "@/lib/contracts";
import { ActionCard } from "./ActionCard";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => false }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}), useMutation: () => ({ mutate, isPending: false }) }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useToast: () => ({ toast: vi.fn(), announce: vi.fn() }),
  useOnline: () => true,
}));
afterEach(() => {
  cleanup();
  mutate.mockClear();
});

it("renders saved waiting pins as Pinned/Unpin and sends unpin, then restores Pin to top", () => {
  const action: NextAction = {
    id: "paperclip:waiting",
    sourceId: "waiting",
    source: "paperclip",
    title: "Waiting task",
    status: "waiting",
    priorityReason: "upcoming",
    href: "/work",
    updatedAt: "2026-10-10T17:00:00Z",
    fetchedAt: "2026-10-10T17:00:00Z",
    staleAfter: "2026-10-11T17:00:00Z",
  };
  const select = (pinned: Set<string>) => selectAttention({ actions: [action], pinned, now: new Date(action.updatedAt), timezone: "UTC" }).waiting[0]!;
  const view = render(<ActionCard action={select(new Set([action.id]))} />);
  expect(screen.getByText("Pinned")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "More actions for Waiting task" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  expect(mutate).toHaveBeenCalledWith({ actionId: action.id, kind: "unpin" }, expect.any(Object));
  view.rerender(<ActionCard action={select(new Set())} />);
  expect(screen.queryByText("Pinned")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More actions for Waiting task" }));
  expect(screen.getByRole("menuitem", { name: "Pin to top" })).toBeDefined();
});
