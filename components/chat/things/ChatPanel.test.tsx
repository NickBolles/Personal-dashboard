// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ChatPanel, RunningSection } from "./ChatPanel";
import { chatThings } from "@/lib/chat/things";
import type { ChatExecutionResponse } from "@/lib/chat-execution";
afterEach(cleanup);
const data = (): ChatExecutionResponse => ({
  sessionId: "s",
  parent: null,
  records: [],
  sources: [{ source: "transcript", state: "ok" }],
  fetchedAt: "2026-11-05T00:00:00Z",
});
/** The Files section reads the chat's files: give it an empty list instead of a request. */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["chat-files", "s"], []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const section = (id: string) => screen.getByTestId("chat-panel-content").querySelector<HTMLElement>(`[data-section="${id}"]`)!;
describe("ChatPanel: In this chat", () => {
  it("draws a fixed section for each kind, in the same order, with one quiet line where there is nothing", () => {
    const execution = data();
    render(
      <ChatPanel
        sessionId="s"
        open
        wide
        tab="Running"
        onTab={() => {}}
        onClose={() => {}}
        things={chatThings({ links: [], execution, filesCount: 0 })}
        links={[]}
        context={[]}
        readOnly={false}
        onPatch={() => {}}
        onRemoveContext={() => {}}
        execution={execution}
        retry={() => {}}
        onAddContext={() => {}}
      />,
      { wrapper },
    );
    // No tabs: every kind is on the page at once.
    expect(screen.queryByRole("tab")).toBeNull();
    const panel = screen.getByTestId("chat-panel-content");
    expect([...panel.querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section"))).toEqual([
      "Running",
      "Waiting",
      "PRs",
      "Artifacts",
      "Files",
      "Links",
      "Context",
    ]);
    expect(screen.getByRole("heading", { name: "Running · 0" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Waiting on you · 0" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pull requests · 0" })).toBeTruthy();
    expect(within(section("Running")).getByText("No agents or jobs for this chat")).toBeTruthy();
    expect(within(section("Waiting")).getByText("Nothing is waiting on you")).toBeTruthy();
    for (const id of ["PRs", "Artifacts", "Files", "Links"]) expect(within(section(id)).getByText("None yet")).toBeTruthy();
    expect(within(section("Context")).getByRole("button", { name: "Add context" })).toBeTruthy();
  });
  it("puts each thing in its own section: what waits on you, pull requests, artifacts and other links", () => {
    const execution = data();
    execution.records = [
      { id: "run", key: "run", source: "subagent", title: "Check delivery times", state: "running" },
      { id: "ask", key: "ask", source: "registered_run", title: "Budget ceiling", state: "waiting" },
    ];
    const links = [
      {
        url: "https://github.com/o/r/pull/7",
        kind: "github" as const,
        domain: "github.com",
        title: "Fix coupon test",
        repo: "o/r",
        number: 7,
        ghType: "pull" as const,
        state: "open",
        pinned: false,
      },
      {
        url: "https://artifacts.example/frames",
        kind: "artifact" as const,
        domain: "artifacts.example",
        title: "Frame comparison",
        slug: "frames",
        pinned: false,
      },
      { url: "https://example.com/e7", kind: "web" as const, domain: "example.com", title: "Flexidesk E7", pinned: true },
    ];
    render(
      <ChatPanel
        sessionId="s"
        open
        wide
        tab="PRs"
        onTab={() => {}}
        onClose={() => {}}
        things={chatThings({ links, execution, filesCount: 0 })}
        links={links}
        context={[]}
        readOnly={false}
        onPatch={() => {}}
        onRemoveContext={() => {}}
        execution={execution}
        retry={() => {}}
        onAddContext={() => {}}
        pending={<p>Approval waiting</p>}
      />,
      { wrapper },
    );
    expect(within(section("Running")).getAllByText("Check delivery times").length).toBeGreaterThan(0);
    expect(within(section("Running")).queryByText("Budget ceiling")).toBeNull();
    expect(screen.getByRole("heading", { name: "Waiting on you · 2" })).toBeTruthy();
    expect(within(section("Waiting")).getAllByText("Budget ceiling").length).toBeGreaterThan(0);
    expect(within(section("Waiting")).getByText("Approval waiting")).toBeTruthy();
    expect(within(section("PRs")).getByText("Fix coupon test")).toBeTruthy();
    expect(within(section("Artifacts")).getByText("Frame comparison")).toBeTruthy();
    expect(within(section("Links")).getByText("Flexidesk E7")).toBeTruthy();
    expect(within(section("Links")).queryByText("Fix coupon test")).toBeNull();
    expect(within(section("Links")).queryByText("Frame comparison")).toBeNull();
  });
  it("shows unavailable sources and retries instead of asserting empty", () => {
    const retry = vi.fn();
    render(
      <RunningSection
        execution={{ ...data(), sources: [{ source: "hermes_children", state: "unavailable", detail: "ECONNREFUSED 10.0.0.4" }] }}
        retry={retry}
      />,
    );
    // One plain line: no source name, no raw detail.
    expect(screen.getByText(/Couldn't check background work/)).toBeTruthy();
    expect(screen.queryByText(/hermes children|ECONNREFUSED/i)).toBeNull();
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
    // The failed refresh is said once, in plain words; a saved status that may be old is not a message of its own.
    expect(screen.getAllByText(/Couldn't check background work/)).toHaveLength(1);
    expect(screen.queryByText(/stale|jarvis runs|Last refresh failed/i)).toBeNull();
    expect(screen.getAllByText("Saved job").length).toBeGreaterThan(0);
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
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("progressbar").length).toBe(1);
    fireEvent.click(screen.getAllByText("Builder")[0]!);
    expect(screen.getByText("/host/transcript.jsonl").tagName).toBe("CODE");
    expect(screen.queryByRole("link", { name: "/host/transcript.jsonl" })).toBeNull();
  });
});
