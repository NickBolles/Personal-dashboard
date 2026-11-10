// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatTray } from "./ChatTray";
import { chatThings, type ChatThingsInput } from "@/lib/chat/things";
import type { ChatExecutionResponse, ExecutionRecord } from "@/lib/chat-execution";
import type { PanelLink } from "@/server/chat/links";

afterEach(cleanup);
const execution = (records: ExecutionRecord[] = []): ChatExecutionResponse => ({
  sessionId: "s",
  parent: null,
  records,
  sources: [{ source: "transcript", state: "ok" }],
  fetchedAt: "2026-11-05T00:00:00Z",
});
const base: ChatThingsInput = { links: [], execution: execution(), now: 1000 };
const pr: PanelLink = { url: "https://github.com/n/r/pull/1", title: "PR", kind: "github", ghType: "pull", domain: "github.com", pinned: false, state: "open" };

describe("ChatTray", () => {
  it("renders nothing for an idle chat: no status line, no zero counts, no jargon", () => {
    const view = render(<ChatTray things={chatThings(base)} onOpen={() => {}} />);
    expect(view.container.innerHTML).toBe("");
    // Background-work sources that are merely "stale" (their standing caveat) are not a headline either.
    view.rerender(
      <ChatTray things={chatThings({ ...base, execution: { ...execution(), sources: [{ source: "hermes_children", state: "stale" }] } })} onOpen={() => {}} />,
    );
    expect(view.container.innerHTML).toBe("");
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });
  it("keeps a live workflow's capture chips even when nothing else shows", () => {
    render(<ChatTray things={chatThings(base)} onOpen={() => {}} accessory={<span>Next note goes to</span>} />);
    expect(screen.getByTestId("chat-tray").textContent).toBe("Next note goes to");
  });
  it("shows only the things this chat has, each opening its tab", () => {
    const onOpen = vi.fn();
    render(<ChatTray things={chatThings({ ...base, links: [pr], filesCount: 0 })} onOpen={onOpen} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["PRs 1"]);
    fireEvent.click(screen.getByRole("button", { name: "PRs 1" }));
    expect(onOpen).toHaveBeenCalledWith("PRs");
  });
  it("keeps waiting, running and failed states prominent and named by what they say", () => {
    const onOpen = vi.fn();
    const view = render(<ChatTray things={chatThings({ ...base, pending: { approval: true } })} onOpen={onOpen} />);
    const status = screen.getByTestId("chat-tray-status");
    expect(status.getAttribute("data-tone")).toBe("warn");
    expect(status.textContent).toBe("Needs youApproval waiting in the conversationReview");
    fireEvent.click(status);
    expect(onOpen).toHaveBeenCalledWith("Running");
    view.rerender(<ChatTray things={chatThings({ ...base, parentFailed: true })} onOpen={onOpen} />);
    expect(screen.getByTestId("chat-tray-status").getAttribute("data-tone")).toBe("bad");
    view.rerender(
      <ChatTray
        things={chatThings({ ...base, execution: execution([{ key: "a", id: "a", source: "subagent", title: "Audit", state: "running" }]) })}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByTestId("chat-tray-status").textContent).toContain("RunningAudit");
  });
  it("says a failed background check in plain words with Retry, only where it matters", () => {
    const retry = vi.fn();
    const view = render(<ChatTray things={chatThings({ ...base, executionUnavailable: true })} onOpen={() => {}} onRetry={retry} />);
    expect(view.container.innerHTML).toBe("");
    view.rerender(<ChatTray things={chatThings({ ...base, executionUnavailable: true, expectsBackground: true })} onOpen={() => {}} onRetry={retry} />);
    expect(screen.getByRole("status").textContent).toContain("Couldn't check background work");
    expect(screen.queryByTestId("chat-tray-status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
