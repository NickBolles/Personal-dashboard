// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_UNDO_SECONDS, ApprovalCard } from "@/components/approvals/ApprovalCard";
import type { ApprovalRequest } from "@/lib/hermes";

const req = (requestId: string | undefined, command = "rm -rf build"): ApprovalRequest => ({
  requestId,
  command,
  description: "Delete the build folder",
  choices: ["once", "session", "deny"],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ApprovalCard safety", () => {
  it("approves only after the 8 s undo window", async () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await act(async () => void vi.advanceTimersByTime((APPROVE_UNDO_SECONDS - 1) * 1000));
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("Undo cancels the pending approval", async () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("Deny is sent immediately, with no undo window", async () => {
    const onAnswer = vi.fn();
    render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("deny");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a withdrawn prompt (card unmounts) during the undo window is never approved", async () => {
    const onAnswer = vi.fn();
    const { unmount } = render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await act(async () => void vi.advanceTimersByTime(3000));
    unmount();
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ["a new request id", req("r2", "rm -rf build")],
    ["a different command when Hermes sends no id", req(undefined, "rm -rf dist")],
  ])("a prompt replaced by %s during the undo window is never approved", async (_label, next) => {
    const onAnswer = vi.fn();
    const first = next.requestId ? req("r1") : req(undefined);
    const { rerender } = render(<ApprovalCard approval={first} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await act(async () => void vi.advanceTimersByTime(3000));
    rerender(<ApprovalCard approval={next} onAnswer={onAnswer} />);
    // The replacement shows fresh choices, not the old countdown.
    expect(screen.getByRole("button", { name: "Approve once" })).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("ApprovalCard send failure", () => {
  it("says it couldn't send, keeps the raw error folded, and Retry resends the same choice", async () => {
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error('Hermes returned 400: {"error": {"code": "invalid_params"}}')).mockResolvedValueOnce(undefined);
    render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Deny" })));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't send your denial.");
    const details = alert.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("invalid_params");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(onAnswer).toHaveBeenNthCalledWith(2, "deny");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed approval says 'approval' and the failure doesn't carry over to a new prompt", async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error("boom"));
    const { rerender } = render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await act(async () => void vi.advanceTimersByTime(APPROVE_UNDO_SECONDS * 1000));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't send your approval.");
    rerender(<ApprovalCard approval={req("r2")} onAnswer={onAnswer} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a prompt replaced while the send is in flight never inherits the failure or Retry", async () => {
    let reject!: (e: Error) => void;
    const onAnswer = vi.fn(() => new Promise<void>((_, r) => (reject = r)));
    const { rerender } = render(<ApprovalCard approval={req("r1")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    rerender(<ApprovalCard approval={req("r2")} onAnswer={onAnswer} />);
    await act(async () => reject(new Error("boom")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
