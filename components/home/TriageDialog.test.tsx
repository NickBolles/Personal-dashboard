// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/client/api";
import { TriageDialog } from "./TriageDialog";

const mocks = vi.hoisted(() => ({ invalidate: vi.fn(), toast: vi.fn(), announce: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock("@/lib/client/api", async (original) => ({ ...(await original<typeof import("@/lib/client/api")>()), api: { post: vi.fn() } }));
vi.mock("@/components/ui", () => ({
  useOnline: () => true,
  useToast: () => mocks,
  cx: (...values: unknown[]) => values.filter(Boolean).join(" "),
  inputCls: "",
  Dialog: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div role="dialog">
      {children}
      {footer}
    </div>
  ),
  Field: ({ children, id, label }: { children: ReactNode; id: string; label: string }) => (
    <div>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  ),
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />,
  ButtonLink: ({ variant: _variant, ...props }: ComponentProps<"a"> & { variant?: string }) => <a {...props} />,
}));
const items = [1, 2, 3].map((id) => ({ id: `todos:${id}`, title: `Task ${id}`, due: "2026-10-01" }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function confirm() {
  render(<TriageDialog open onClose={vi.fn()} items={items} timezone="America/Chicago" />);
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
  fireEvent.click(screen.getByRole("button", { name: "Review 3 changes" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and reschedule" }));
}

it("keeps partial success separate from writes with failed readback or lost HTTP responses, without retrying", async () => {
  vi.mocked(api.post)
    .mockResolvedValueOnce({ ok: true, message: "Snoozed" })
    .mockRejectedValueOnce(new ApiError(502, "Home Assistant did not confirm the new due date", "upstream_bad_response"))
    .mockRejectedValueOnce(new ApiError(0, "Couldn't reach Jarvis", "network"));
  confirm();
  await waitFor(() => expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(false));
  const rows = screen.getAllByRole("listitem");
  expect(within(rows[0]).getByText(/^Now due/)).toBeTruthy();
  for (const row of rows.slice(1)) expect(row.textContent).toContain("Unverified — may have changed");
  expect(screen.queryByText(/Not changed/)).toBeNull();
  expect(screen.getByText(/Check your todo list before trying again/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Check todo list" }).getAttribute("href")).toBe("/todos");
  expect(mocks.toast).toHaveBeenCalledWith("Verified 1 of 3; 2 unverified — may have changed", "warn");
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["home"] });
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["source"] });
  expect(api.post).toHaveBeenCalledTimes(3);
  expect(vi.mocked(api.post).mock.calls.map(([, body]) => (body as { actionId: string }).actionId)).toEqual(items.map((i) => i.id));
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
});

it.each([undefined, { ok: false }, "not JSON"])("never counts an unconfirmed successful HTTP body as verified: %j", async (response) => {
  vi.mocked(api.post).mockResolvedValue(response);
  confirm();
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(screen.queryByText(/^Now due/)).toBeNull();
  expect(screen.getAllByText(/Unverified — may have changed/)).toHaveLength(3);
  expect(mocks.toast).toHaveBeenCalledWith("Verified 0 of 3; 3 unverified — may have changed", "warn");
  expect(api.post).toHaveBeenCalledTimes(3);
});

it("waits for the entire batch before offering read-only reconciliation", async () => {
  let finish!: (value: { ok: true }) => void;
  vi.mocked(api.post)
    .mockRejectedValueOnce(new ApiError(502, "Readback failed"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ ok: true });
  confirm();
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Working…" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("link", { name: "Check todo list" })).toBeNull();
  await act(async () => finish({ ok: true }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Check todo list" })).toBeTruthy());
  expect(api.post).toHaveBeenCalledTimes(3);
});

it.each([
  ["2026-10-10T05:30:00Z", "America/Chicago", "2026-10-10", ["2026-10-11", "2026-10-17", "2026-10-12", "2026-10-24"]],
  ["2026-03-08T06:30:00Z", "America/Chicago", "2026-03-08", ["2026-03-09", "2026-03-14", "2026-03-09", "2026-03-22"]],
  ["2026-11-01T05:30:00Z", "America/Chicago", "2026-11-01", ["2026-11-02", "2026-11-07", "2026-11-02", "2026-11-15"]],
  ["2026-03-09T00:30:00Z", "America/Los_Angeles", "2026-03-08", ["2026-03-09", "2026-03-14", "2026-03-09", "2026-03-22"]],
])("uses household calendar presets and validation at %s in %s", async (instant, timezone, today, dates) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(instant));
  vi.mocked(api.post).mockResolvedValue({ ok: true });
  render(<TriageDialog open onClose={vi.fn()} items={items} timezone={timezone} />);
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  const input = screen.getByLabelText("Or pick a date") as HTMLInputElement;
  expect(input.min).toBe(dates[0]);
  for (const [index, label] of ["Tomorrow", "Saturday", "Next Monday", "In 2 weeks"].entries()) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(input.value).toBe(dates[index]);
  }
  fireEvent.change(input, { target: { value: today } });
  expect(screen.getByRole("button", { name: "Review 3 changes" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
  fireEvent.click(screen.getByRole("button", { name: "Review 3 changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and reschedule" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  for (const item of items) expect(api.post).toHaveBeenCalledWith("/api/actions", { actionId: item.id, kind: "snooze", until: dates[0] });
});

it("does not guess a browser timezone before household settings load", () => {
  render(<TriageDialog open onClose={vi.fn()} items={items} />);
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.change(screen.getByLabelText("Or pick a date"), { target: { value: "2099-01-01" } });
  expect(screen.getByRole("button", { name: "Review 3 changes" }).hasAttribute("disabled")).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it("revalidates household midnight before confirming an idle dialog", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-08T05:59:00Z"));
  render(<TriageDialog open onClose={vi.fn()} items={items} timezone="America/Chicago" />);
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
  fireEvent.click(screen.getByRole("button", { name: "Review 3 changes" }));
  clock.mockReturnValue(Date.parse("2026-03-08T06:01:00Z"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and reschedule" }));
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Or pick a date").getAttribute("min")).toBe("2026-03-09");
});

it("uses settings arriving after mount without retaining browser-derived choices", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T05:30:00Z"));
  const view = render(<TriageDialog open onClose={vi.fn()} items={items} />);
  expect(screen.queryByRole("button", { name: "Tomorrow" })).toBeNull();
  view.rerender(<TriageDialog open onClose={vi.fn()} items={items} timezone="America/Chicago" />);
  fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
  expect((screen.getByLabelText("Or pick a date") as HTMLInputElement).value).toBe("2026-10-11");
});

it("refreshes presets when an open dialog crosses household midnight", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-03-08T05:59:45Z"));
    render(<TriageDialog open onClose={vi.fn()} items={items} timezone="America/Chicago" />);
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect((screen.getByLabelText("Or pick a date") as HTMLInputElement).value).toBe("2026-03-08");
    act(() => vi.advanceTimersByTime(30_000));
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect((screen.getByLabelText("Or pick a date") as HTMLInputElement).value).toBe("2026-03-09");
  } finally {
    vi.useRealTimers();
  }
});

it("reports every verified success without an uncertainty warning", async () => {
  vi.mocked(api.post).mockResolvedValue({ ok: true, message: "Snoozed" });
  confirm();
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(screen.getAllByText(/^Now due/)).toHaveLength(3);
  expect(screen.queryByText(/may have changed/)).toBeNull();
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/^Moved 3 tasks to/), "ok");
});
