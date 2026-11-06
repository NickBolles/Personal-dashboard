// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { QuickActionsHost } from "./ManageQuickActions";

vi.mock("next/navigation", () => ({ usePathname: () => "/more" }));
vi.mock("@/lib/client/api", () => ({ api: { post: vi.fn().mockResolvedValue({ ok: true }), get: vi.fn().mockResolvedValue({ actions: [] }) } }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useToast: () => ({ toast: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  document.querySelectorAll("dialog.gc-sheet").forEach((el) => el.remove());
  vi.clearAllMocks();
});
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <QuickActionsHost />
    </QueryClientProvider>,
  );
}
function sheet() {
  const dialog = document.createElement("dialog");
  dialog.className = "gc-sheet";
  dialog.setAttribute("open", "");
  const target = document.createElement("div");
  target.setAttribute("data-quick-action-notices", "");
  dialog.append(target);
  document.body.append(dialog);
  return { dialog, target };
}
function added() {
  act(() => {
    window.dispatchEvent(new CustomEvent("jarvis:quick-action-added", { detail: { opId: "op-proposal" } }));
  });
}
it("portals Added status and its working Undo into the open sheet", async () => {
  mount();
  const { target, dialog } = sheet();
  added();
  const status = within(target).getByRole("status");
  expect(status.textContent).toContain("Added ·");
  fireEvent.click(within(status).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/quick-actions/undo", { opId: "op-proposal" }));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(dialog.hasAttribute("open")).toBe(true);
});
it("moves an existing notice between body and the sheet as the top layer changes", async () => {
  mount();
  added();
  expect(screen.getByRole("status").parentElement).toBe(document.body);
  const { dialog, target } = sheet();
  await waitFor(() => expect(screen.getByRole("status").parentElement).toBe(target));
  dialog.removeAttribute("open");
  await waitFor(() => expect(screen.getByRole("status").parentElement).toBe(document.body));
  fireEvent.click(screen.getByRole("button", { name: "Close quick action notice" }));
  expect(screen.queryByRole("status")).toBeNull();
});
