// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import type { ExternalRun, ItemAgentInfo } from "@/lib/agent-runs";
import type { JobView, ReportView } from "@/lib/ai";
import { api } from "@/lib/client/api";
import type { RunEvent } from "@/lib/cw-runs";
import type { CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { itemTimeline, itemWorkRows, type ItemWorkRow } from "@/lib/item-page";
import { ItemTimeline, ItemWorkList } from "./ItemWork";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/areas" }));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => true, isAdmin: true }) }));

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const run = (id: string, over: Partial<ExternalRun> = {}): ExternalRun => ({
  id,
  title: `Run ${id}`,
  profile: "devchief",
  state: "running",
  summary: null,
  prUrl: null,
  startedAt: iso(now - 120 * MIN),
  updatedAt: iso(now - MIN),
  ...over,
});
const tracked = (id: string): CoordinatorRunRow =>
  ({
    id,
    ref: `R-${id}`,
    seq: 1,
    itemId: "a",
    title: `Run ${id}`,
    state: "running",
    stalled: false,
    parentRunId: null,
    pipeline: [],
    noticeCount: 0,
  }) as unknown as CoordinatorRunRow;
const info = (over: Partial<ItemAgentInfo>): ItemAgentInfo => ({
  itemId: "a",
  areaId: null,
  title: "Item",
  who: null,
  live: "running",
  liveAt: null,
  sessionId: null,
  runs: 1,
  prs: [],
  report: null,
  progress: null,
  ...over,
});
const job = (over: Partial<JobView> = {}): JobView =>
  ({
    id: "job1",
    kind: "research",
    state: "running",
    createdAt: iso(now - 5 * MIN),
    startedAt: iso(now - 4 * MIN),
    finishedAt: null,
    errorMessage: null,
    conversationId: null,
    ...over,
  }) as JobView;
const report = (id: string, over: Partial<ReportView> = {}): ReportView =>
  ({
    id,
    kind: "research",
    title: `Report ${id}`,
    createdAt: iso(now - 30 * MIN),
    sourceCount: 2,
    supersededBy: null,
    archivedAt: null,
    readAt: iso(now),
    ...over,
  }) as ReportView;

let client: QueryClient;
function mount(children: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}
function List({ rows, timeline }: { rows: ItemWorkRow[]; timeline?: RunEvent[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  return (
    <ItemWorkList
      itemId="a"
      areaId={null}
      rows={rows}
      timeline={timeline}
      sessionId="sess_1"
      open={open}
      onToggle={(key) =>
        setOpen((s) => {
          const n = new Set(s);
          if (n.has(key)) n.delete(key);
          else n.add(key);
          return n;
        })
      }
    />
  );
}
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  push.mockReset();
});

it("draws nothing when the item has no work", () => {
  const view = mount(<List rows={[]} />);
  expect(view.container.querySelector("section")).toBeNull();
});

it("lists runs once, Needs you before Working, in the shared words and with at most two icon actions", () => {
  const rows = itemWorkRows({
    info: info({
      live: "waiting",
      agentRuns: [
        run("2"),
        run("1", { state: "waiting", summary: "Waiting on your budget ceiling.", hermesSessionId: "sess_run" }),
        run("3", { updatedAt: iso(now - 45 * MIN) }),
      ],
    }),
    runs: [tracked("1"), tracked("2"), tracked("3")],
    now,
  });
  mount(<List rows={rows} />);
  const panel = screen.getByTestId("item-agent-panel");
  const drawn = within(panel).getAllByTestId("agent-run");
  expect(drawn.map((el) => el.getAttribute("data-state"))).toEqual(["needs", "stalled", "working"]);
  expect(drawn[0]!.textContent).toContain("R-1");
  expect(within(drawn[0]!).getByTestId("agent-live").textContent).toBe("Needs you");
  expect(within(drawn[1]!).getByTestId("agent-stalled").textContent).toBe("Stalled");
  expect(within(drawn[2]!).getByTestId("agent-live").textContent).toBe("Working");
  // The words this page used to say are gone.
  expect(panel.textContent).not.toMatch(/Running|Waiting for approval|Finished|Quiet|Interrupted/);
  for (const el of drawn) expect(el.querySelectorAll(".k-thing-acts button").length).toBeLessThanOrEqual(2);
  fireEvent.click(within(drawn[0]!).getByRole("button", { name: "Open conversation" }));
  expect(push).toHaveBeenCalledWith("/chat/sess_run");
  fireEvent.click(within(drawn[0]!).getByRole("button", { name: "Log of R-1" }));
  expect(push).toHaveBeenLastCalledWith("/areas?item=a&coord=running&r=R-1");
});

it("opens a run in place for its report line, sub-agents and the ids to copy", () => {
  const rows = itemWorkRows({
    info: info({
      agentRuns: [
        run("1", {
          summary: "Cutting the mortise",
          delegationId: "dlg_1",
          transcriptPath: "/tmp/run.jsonl",
          children: [{ title: "Measure the tenon", state: "done", summary: "3/8 inch fits" }],
        }),
      ],
    }),
    now,
  });
  mount(<List rows={rows} />);
  const row = screen.getByTestId("agent-run");
  expect(within(row).queryByTestId("agent-run-children")).toBeNull();
  fireEvent.click(within(row).getByRole("button", { expanded: false }));
  expect(within(row).getByTestId("agent-run-children").textContent).toContain("3/8 inch fits");
  expect(within(row).getByTestId("agent-run-children").textContent).toContain("Done");
  expect(
    within(row)
      .getAllByTestId("agent-run-copy")
      .map((el) => el.textContent),
  ).toEqual(["dlg_1", "/tmp/run.jsonl"]);
});

it("Stop on a job asks once in place before anything is sent, and Keep backs out", async () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({});
  mount(<List rows={itemWorkRows({ jobs: [job()], now })} />);
  const row = screen.getByTestId("ai-job-chip");
  expect(row.textContent).toContain("Working");
  fireEvent.click(within(row).getByRole("button", { name: "Stop Research" }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole("button", { name: "Keep" }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole("button", { name: "Stop Research" }));
  fireEvent.click(within(row).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith("/api/ai/jobs/job1/cancel", {}));
});

it("a job held by the budget only runs on its explicit Run anyway", async () => {
  const post = vi.spyOn(api, "post").mockResolvedValue({});
  mount(<List rows={itemWorkRows({ jobs: [job({ state: "budget_blocked" })], now })} />);
  const row = screen.getByTestId("ai-job-chip");
  expect(row.textContent).toContain("Needs you");
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole("button", { name: "Run anyway" }));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith("/api/ai/jobs/job1/run-anyway", {}));
});

it("folds finished work into one Done row once there is more than one", () => {
  mount(<List rows={itemWorkRows({ reports: [report("1"), report("2")], now })} />);
  expect(screen.queryAllByTestId("ai-report-row")).toHaveLength(0);
  const done = within(screen.getByTestId("work-done")).getByRole("button");
  expect(done.textContent).toContain("Done");
  expect(done.textContent).toContain("2 finished");
  fireEvent.click(done);
  expect(screen.getAllByTestId("ai-report-row")).toHaveLength(2);
});

it("shows a single finished report directly, and an unread one keeps Done open", () => {
  const one = mount(<List rows={itemWorkRows({ reports: [report("1")], now })} />);
  expect(screen.getAllByTestId("ai-report-row")).toHaveLength(1);
  one.unmount();
  mount(<List rows={itemWorkRows({ reports: [report("1"), report("2", { readAt: null })], now })} />);
  expect(screen.getAllByTestId("ai-report-row")).toHaveLength(2);
  expect(screen.getByRole("img", { name: "Unread" })).toBeTruthy();
});

it("the timeline shows the newest four entries, then Show earlier, and links to the conversation", () => {
  const events: RunEvent[] = Array.from({ length: 6 }, (_, i) => ({
    id: `e${i}`,
    runId: "1",
    runRef: "R-1",
    type: "progress",
    summary: `Step ${i}`,
    payload: {},
    via: null,
    at: iso(now - (i + 1) * 10 * MIN),
  }));
  const timeline = itemTimeline({ itemId: "a", runs: [tracked("1")], events });
  mount(<ItemTimeline events={timeline} sessionId="sess_1" />);
  const list = screen.getByRole("list", { name: /newest first/ });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent?.includes("Step 0")),
  ).toEqual([true, false, false, false]);
  expect(screen.getByRole("link", { name: "Open conversation" }).getAttribute("href")).toBe("/chat/sess_1");
  fireEvent.click(screen.getByRole("button", { name: "Show earlier (2)" }));
  expect(within(list).getAllByRole("listitem")).toHaveLength(6);
  expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
});

it("draws no timeline when nothing has been reported", () => {
  const view = mount(<ItemTimeline events={[]} />);
  expect(view.container.textContent).toBe("");
});
