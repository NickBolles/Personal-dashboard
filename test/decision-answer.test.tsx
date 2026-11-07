// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { DecisionAnswer } from "@/components/decisions/DecisionAnswer";
import { api } from "@/lib/client/api";
import { ToastProvider } from "@/components/ui";
import type { DecisionEntry } from "@/lib/decisions";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const entry: DecisionEntry = {
  key: "item:wk_review",
  kind: "item",
  itemId: "wk_review",
  title: "Review",
  question: "Pick the route?",
  choices: ["Cedar", "Spruce"],
  at: "",
  href: "/areas?item=wk_review",
};
it("stages options and confirms before using the existing undoable answer API", async () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({ op: { id: "op_answer", kind: "edit", label: "Answered" } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <DecisionAnswer entry={entry} initialChoice="untrusted option" />
      </ToastProvider>
    </QueryClientProvider>,
  );
  expect((screen.getByLabelText("Your answer") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Spruce" }));
  const dialog = screen.getByRole("dialog", { name: "Confirm decision" });
  expect(dialog.textContent).toContain("Spruce");
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Answer…" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Confirm decision" })).getByRole("button", { name: "Record decision" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/work/items/wk_review/decision", { answer: "Spruce", postToConversation: false }));
  expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(1);
});
