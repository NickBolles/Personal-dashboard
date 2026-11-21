// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatWork } from "@/components/coordinator/CoordinatorThread";
import { quietChatWork, type BackgroundWork } from "@/lib/coordinator/run-card";
vi.mock("next/navigation", () => ({ usePathname: () => "/chief", useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);
const now = Date.now();
const work = (id: string, state: "running" | "failed" | "waiting" = "running", error?: string): BackgroundWork => ({
  record: { key: `subagent:${id}`, id, source: "subagent", title: id, state, updatedAt: new Date(now - 3_600_000).toISOString(), error },
});
it("deduplicates quiet stalls into one disclosure, keeps original rows and Activity reachable, does not hide failures/approvals", () => {
  const stalled = work("quiet");
  const failed = work("failed", "failed");
  const waiting = work("approval", "waiting");
  const errored = work("new error", "running", "failed command");
  const onActivity = vi.fn();
  const rows = [stalled, stalled, failed, waiting, errored];
  const before = JSON.stringify(rows);
  render(<ChatWork work={rows} render={(w) => <p key={w.record.id}>{w.record.title}</p>} onActivity={onActivity} />);
  expect(screen.queryByText("quiet")).toBeNull();
  expect(screen.getByText("failed")).toBeTruthy();
  expect(screen.getByText("approval")).toBeTruthy();
  expect(screen.getByText("new error")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Activity" }));
  expect(onActivity).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "1 stalled run" }));
  expect(screen.getAllByText("quiet")).toHaveLength(1);
  expect(JSON.stringify(rows)).toBe(before);
});
it("uses last heartbeat, not start time or prose, to collapse silence", () => {
  expect(quietChatWork(work("quiet"), now)).toBe(true);
  const fresh = work("fresh");
  fresh.record.updatedAt = new Date(now).toISOString();
  expect(quietChatWork(fresh, now)).toBe(false);
  delete fresh.record.updatedAt;
  expect(quietChatWork(fresh, now)).toBe(false);
  expect(quietChatWork(work("waiting", "waiting"), now)).toBe(false);
});
