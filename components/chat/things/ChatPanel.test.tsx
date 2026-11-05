// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ChatPanel, RunningSection } from "./ChatPanel";
import { chatThings, type ThingsTab } from "@/lib/chat/things";
import type { ChatExecutionResponse } from "@/lib/chat-execution";
afterEach(cleanup);
const data = (): ChatExecutionResponse => ({
  sessionId: "s",
  parent: null,
  records: [],
  sources: [{ source: "transcript", state: "ok" }],
  fetchedAt: "2026-11-05T00:00:00Z",
});
describe("ChatPanel Running tab", () => {
  it("renders shared chip tabs with selected state and arrow-key navigation", () => {
    function Panel() {
      const [tab, onTab] = useState<ThingsTab>("Running");
      const execution = data();
      return (
        <ChatPanel
          sessionId="s"
          open
          wide
          tab={tab}
          onTab={onTab}
          onClose={() => {}}
          things={chatThings({ links: [], execution })}
          links={[]}
          context={[]}
          readOnly={false}
          onPatch={() => {}}
          onRemoveContext={() => {}}
          execution={execution}
          retry={() => {}}
          onAddContext={() => {}}
        />
      );
    }
    render(<Panel />);
    const running = screen.getByRole("tab", { name: "Running 0" });
    expect(running.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("No agents or jobs for this chat")).toBeTruthy();
    fireEvent.keyDown(running, { key: "ArrowLeft" });
    const prs = screen.getByRole("tab", { name: "PRs 0" });
    expect(prs.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(prs);
  });
  it("shows unavailable sources and retries instead of asserting empty", () => {
    const retry = vi.fn();
    render(<RunningSection execution={{ ...data(), sources: [{ source: "hermes_children", state: "unavailable" }] }} retry={retry} />);
    expect(screen.getByText(/Couldn't load hermes children/)).toBeTruthy();
    expect(screen.queryByText("No agents or jobs for this chat")).toBeNull();
    const button = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
  });
  it("only claims empty when every source is ok", () => {
    const { rerender } = render(<RunningSection execution={data()} retry={() => {}} />);
    expect(screen.getByText("No agents or jobs for this chat")).toBeTruthy();
    rerender(<RunningSection execution={{ ...data(), sources: [] }} retry={() => {}} />);
    expect(screen.queryByText("No agents or jobs for this chat")).toBeNull();
    rerender(<RunningSection execution={data()} error retry={() => {}} />);
    expect(screen.queryByText("No agents or jobs for this chat")).toBeNull();
  });
  it("keeps known records visible when a source is stale or a refetch fails", () => {
    const d = data();
    d.sources = [{ source: "jarvis_runs", state: "stale", detail: "Last refresh failed" }];
    d.records = [{ id: "job", key: "job", source: "process", title: "Saved job", state: "failed", error: "Exit code 1" }];
    render(<RunningSection execution={d} error retry={() => {}} />);
    expect(screen.getByText(/saved status may be stale/)).toBeTruthy();
    expect(screen.getByText("Saved job")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.queryByText("No agents or jobs for this chat")).toBeNull();
  });
  it("does not turn host paths or external child hrefs into navigation", () => {
    const d = data();
    d.parent = { id: "bad", title: "Bad parent", href: "//evil.example/chat/parent" };
    d.records = [
      {
        id: "bad",
        key: "bad",
        source: "subagent",
        title: "Unsafe link",
        state: "unknown",
        childSessionId: "bad",
        href: "https://evil.example/chat/bad",
        transcriptPath: "/host/transcript.jsonl",
      },
    ];
    render(<RunningSection execution={d} retry={() => {}} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
  it("groups running and finished with truthful unknowns, optional progress and child/parent navigation", () => {
    const d = data();
    d.parent = { id: "parent", title: "Parent", href: "/chat/parent" };
    d.records = [
      {
        id: "child",
        key: "child",
        source: "subagent",
        title: "Builder",
        state: "running",
        href: "/chat/child",
        childSessionId: "child",
        childProfile: "devchief",
        step: "Typechecking",
        progress: 0.5,
        transcriptPath: "/host/transcript.jsonl",
      },
      { id: "job", key: "job", source: "process", title: "Tests", state: "completed", summary: "Passed" },
      { id: "unknown", key: "unknown", source: "registered_run", title: "Unreported", state: "unknown" },
    ];
    render(<RunningSection execution={d} retry={() => {}} />);
    expect(screen.getByRole("region", { name: "Running" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Finished" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "↩ Back to parent chat" }).getAttribute("href")).toBe("/chat/parent");
    expect(screen.getByRole("link", { name: "Open child chat · @devchief" }).getAttribute("href")).toBe("/chat/child");
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.getAllByRole("progressbar").length).toBe(1);
    fireEvent.click(screen.getByText("Builder"));
    expect(screen.getByText("/host/transcript.jsonl").tagName).toBe("CODE");
    expect(screen.queryByRole("link", { name: "/host/transcript.jsonl" })).toBeNull();
  });
});
