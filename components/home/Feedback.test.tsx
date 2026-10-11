// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { FeedbackBar, type FeedbackTarget } from "./Feedback";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/api", async (original) => ({ ...(await original<typeof import("@/lib/client/api")>()), api: { post: vi.fn() } }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useToast: () => ({ toast, announce: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each(["action", "assist"] as const)("retains a failed %s correction for retry and clears it only after success", async (kind) => {
  const target: FeedbackTarget = { kind, id: "one", category: "todos", title: "Task", fingerprint: "one", why: [], sources: ["todos"] };
  let reject!: (error: Error) => void;
  let resolve!: (value: { message: string }) => void;
  vi.mocked(api.post)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((success) => {
          resolve = success;
        }),
    );
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <FeedbackBar target={target} />
    </QueryClientProvider>,
  );
  const open = () => fireEvent.click(screen.getByRole("button", { name: kind === "assist" ? "Wrong assumption…" : "Ranked wrong…" }));
  open();
  fireEvent.change(screen.getByLabelText("Correction (optional)"), { target: { value: "Keep this substantial correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await act(async () => reject(new Error("Connection lost")));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("Connection lost", "danger"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect((screen.getByLabelText("Correction (optional)") as HTMLTextAreaElement).value).toBe("Keep this substantial correction");
  expect(invalidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Correction (optional)").hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => resolve({ message: "Feedback saved" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenLastCalledWith(
    "/api/home/feedback",
    expect.objectContaining({ correction: "Keep this substantial correction", verdict: "wrong_assumption" }),
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["home"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["home-tuning"] });
  open();
  expect((screen.getByLabelText("Correction (optional)") as HTMLTextAreaElement).value).toBe("");
  qc.clear();
});
