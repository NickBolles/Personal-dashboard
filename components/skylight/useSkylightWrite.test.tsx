// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useSkylightWrite } from "./useSkylightWrite";
import { SkylightUndoBar } from "./SkylightUndoBar";

const state = vi.hoisted(() => ({ online: true, toast: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useOnline: () => state.online,
  useToast: () => ({ toast: state.toast }),
}));
const op = { op: "chore.reopen" as const, choreId: "chore", title: "Lantern chore", categoryId: "member" };
function Harness({ kind = "chore.reopen" }: { kind?: "chore.reopen" | "chore.complete" | "chore.skip" }) {
  const write = useSkylightWrite();
  return (
    <>
      <button type="button" onClick={() => write.request({ ...op, op: kind })}>
        Complete lantern
      </button>
      {write.node}
    </>
  );
}
function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  const opener = screen.getByRole("button", { name: "Complete lantern" });
  act(() => opener.focus());
  fireEvent.click(opener);
  return { ...view, qc, invalidate, opener };
}
beforeEach(() => {
  state.online = true;
  state.toast.mockClear();
  vi.mocked(api.post).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("describes the operation and Cancel makes no request, restoring the opener", () => {
  const { opener } = setup();
  expect(screen.getByRole("dialog").textContent).toContain("Reopen “Lantern chore” in Skylight");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(opener);
});

it("does not reset dialog focus on parent rerender and disables Confirm offline", () => {
  const view = setup();
  const confirm = screen.getByRole("button", { name: "Confirm" });
  act(() => confirm.focus());
  view.rerender(
    <QueryClientProvider client={view.qc}>
      <Harness />
    </QueryClientProvider>,
  );
  expect(document.activeElement).toBe(confirm);
  state.online = false;
  view.rerender(
    <QueryClientProvider client={view.qc}>
      <Harness />
    </QueryClientProvider>,
  );
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(confirm);
  expect(api.post).not.toHaveBeenCalled();
});

it("confirms once, invalidates every dependent source, then undoes and invalidates again", async () => {
  vi.mocked(api.post)
    .mockResolvedValueOnce({ ok: true, writeId: "write/1", undoable: true, message: "Verified upstream" })
    .mockResolvedValueOnce({ ok: true, message: "Undone" });
  const { invalidate } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenNthCalledWith(1, "/api/skylight/write", op);
  expect(screen.getByRole("status").textContent).toContain("Reopened");
  for (const queryKey of [["source", "skylight"], ["home"], ["source", "todos"]]) expect(invalidate).toHaveBeenCalledWith({ queryKey });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(api.post).toHaveBeenNthCalledWith(2, "/api/skylight/write/write%2F1/undo"));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(state.toast).toHaveBeenCalledWith("Undone", "ok");
  expect(invalidate).toHaveBeenCalledTimes(10);
});

it("keeps confirmation open on error and reports the server's message", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Skylight is read-only"));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  // Inside the sheet (a toast hides under it), not a toast.
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Skylight is read-only"));
  expect(state.toast).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeDefined();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Details")).toBeNull();
});

it("shows Skylight's own reason under collapsed Details", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(
    Object.assign(new Error("Skylight couldn't accept that change. Refresh and try again."), { detail: { status: 422, reason: "category_id must be blank" } }),
  );
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("couldn't accept"));
  const details = screen.getByText("Details").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Skylight 422: category_id must be blank");
});

it("disables confirmation and dismissal while a write is pending", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeDefined();
  await act(async () => finish({ ok: true, writeId: "pending", undoable: true, message: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
});

it("undo errors are danger toasts, never an invented Undone success", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("A newer edit prevents undo"));
  const done = vi.fn();
  const undone = vi.fn();
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <SkylightUndoBar op={{ id: "old", label: "Marked done" }} onDone={done} onUndone={undone} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(state.toast).toHaveBeenCalledWith("A newer edit prevents undo", "danger"));
  expect(undone).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});

function ListHarness() {
  const write = useSkylightWrite();
  return (
    <>
      <button onClick={() => write.request({ op: "list.check", listId: "list", itemId: "item", label: "List task", listLabel: "Tasks" })}>
        Check list task
      </button>
      {write.node}
    </>
  );
}
it("list completion is one deliberate click with Undo, not a confirmation modal", async () => {
  vi.mocked(api.post).mockResolvedValue({ ok: true, writeId: "list-check", undoable: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ListHarness />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Check list task" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/skylight/write", {
      op: "list.check",
      listId: "list",
      itemId: "item",
      label: "List task",
      listLabel: "Tasks",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeDefined());
});

function MultiHarness() {
  const write = useSkylightWrite();
  return (
    <>
      <button onClick={() => write.request({ ...op, op: "chore.complete", choreId: "one" })}>First chore</button>
      <button onClick={() => write.request({ ...op, op: "chore.skip", choreId: "two" })}>Second chore</button>
      {write.node}
    </>
  );
}
it("keeps distinct-row clicks while another write is pending, with an Undo for each", async () => {
  const finish: ((value: unknown) => void)[] = [];
  vi.mocked(api.post).mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MultiHarness />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "First chore" }));
  fireEvent.click(screen.getByRole("button", { name: "Second chore" }));
  fireEvent.click(screen.getByRole("button", { name: "First chore" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  await act(async () => finish[0]({ ok: true, writeId: "one", undoable: true }));
  await act(async () => finish[1]({ ok: true, writeId: "two", undoable: true }));
  expect(screen.getByRole("status").textContent).toContain("Skipped");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getByRole("status").textContent).toContain("Marked done");
});

it.each(["chore.complete", "chore.skip"] as const)("%s is deliberate confirmation, double clicks are ignored, Undo remains available", async (kind) => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness kind={kind} />
    </QueryClientProvider>,
  );
  const click = screen.getByRole("button", { name: "Complete lantern" });
  fireEvent.click(click);
  fireEvent.click(click);
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/skylight/write", { ...op, op: kind }));
  await act(async () => finish({ ok: true, writeId: kind, undoable: true }));
  expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
});

it("offline direct clicks send nothing, failed direct clicks stay inline without a modal", async () => {
  state.online = false;
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <Harness kind="chore.skip" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Complete lantern" }));
  expect(api.post).not.toHaveBeenCalled();
  state.online = true;
  view.rerender(
    <QueryClientProvider client={qc}>
      <Harness kind="chore.skip" />
    </QueryClientProvider>,
  );
  vi.mocked(api.post).mockRejectedValueOnce(new Error("Provider refused skip"));
  fireEvent.click(screen.getByRole("button", { name: "Complete lantern" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Provider refused skip"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("undo bar has a draining hairline and dismisses after exactly ten seconds", () => {
  vi.useFakeTimers();
  const done = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SkylightUndoBar op={{ id: "timer", label: "Marked done" }} onDone={done} onUndone={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("status").querySelector(".jv-undo-bar")).not.toBeNull();
  act(() => vi.advanceTimersByTime(9_999));
  expect(done).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(done).toHaveBeenCalledOnce();
});
