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
