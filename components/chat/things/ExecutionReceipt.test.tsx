// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunningSection } from "./ChatPanel";
import type { ChatExecutionResponse } from "@/lib/chat-execution";
afterEach(cleanup);
it("keeps failure visible collapsed and exposes actual task, run history, classified receipts and sanitized exact copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const data: ChatExecutionResponse = {
    sessionId: "source",
    parent: null,
    sources: [{ source: "transcript", state: "ok" }],
    fetchedAt: "2026-11-25T00:00:00Z",
    records: [
      {
        key: "r",
        id: "arun-real",
        source: "registered_run",
        title: "Verify auth. password=abcdefghi",
        state: "failed",
        error: "Exit code 1",
        task: { id: "wk_exact-id", title: "Authentication audit", href: "/areas?item=wk_exact-id" },
        run: { id: "arun-real", ref: "R-7", events: [{ at: "2026-11-25T00:00:00Z", type: "progress", summary: "Checked passkeys" }] },
        sourceChat: { id: "source", href: "/chat/source" },
        links: [
          { kind: "artifact", url: "https://artifacts.ai.nickbolles.com/a/audit/key/" },
          { kind: "github", url: "https://github.com/o/r/pull/7" },
          { kind: "web", url: "file:///host/private" },
        ],
        transcriptPath: "/host/private",
      },
    ],
  };
  render(<RunningSection execution={data} retry={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("Exit code 1");
  fireEvent.click(screen.getByText("Verify auth."));
  expect(screen.getByRole("link", { name: "Authentication audit" }).getAttribute("href")).toBe("/areas?item=wk_exact-id");
  expect(screen.getByRole("link", { name: "Open source chat" }).getAttribute("href")).toBe("/chat/source");
  expect(screen.getByRole("link", { name: "audit" }).getAttribute("href")).toBe("https://artifacts.ai.nickbolles.com/v/audit/");
  expect(screen.getByRole("link", { name: "PR #7" }).className).toContain("chat-inline-chip");
  expect(screen.getByRole("list", { name: "Run history" }).textContent).toContain("Checked passkeys");
  fireEvent.click(screen.getByRole("button", { name: "Copy task id" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("wk_exact-id"));
  fireEvent.click(screen.getByText("Details and copy"));
  fireEvent.click(screen.getByRole("button", { name: "Copy stored brief" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Verify auth. password=[redacted]"));
  expect(screen.queryByRole("link", { name: "/host/private" })).toBeNull();
  expect(document.body.textContent).not.toContain("abcdefghi");
});
it("shows explicit approval separately from generic waiting without inferring from prose", () => {
  const base: ChatExecutionResponse = {
    sessionId: "s",
    parent: null,
    sources: [{ source: "transcript", state: "ok" }],
    fetchedAt: "now",
    records: [
      { id: "a", key: "a", source: "jarvis_run", title: "Approve audit", state: "waiting", approval: true },
      { id: "b", key: "b", source: "registered_run", title: "Waiting for dependency", state: "waiting", summary: "Approval already received" },
    ],
  };
  render(<RunningSection execution={base} retry={() => {}} />);
  expect(screen.getByText("Approval")).toBeTruthy();
  expect(screen.getByText("waiting")).toBeTruthy();
});
