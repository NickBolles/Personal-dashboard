// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { api, ApiError } from "@/lib/client/api";
import { EMPTY_AWAY, scheduleError } from "@/lib/client/away";
import { jobsExportSchema } from "@/lib/away";
import { AccessProvider } from "@/components/access";
import { ScheduledJobsCard } from "@/components/agents/ScheduledJobsCard";
import { WhileAwayCard } from "@/components/agents/WhileAwayCard";
import { AreaAutonomy, AreaSettingsDialog } from "@/components/areas/AreaSettings";
import { useCoordinatorThings } from "@/components/coordinator/useCoordinatorThings";
import { DEFAULT_AREA_SETTINGS, type WorkItem } from "@/lib/work";
import { awayFixture, schedulesFixture } from "../e2e/fixtures/away";
import { skylightTaskUxFixture } from "../e2e/fixtures/skylight-task-ux";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/settings/agents",
}));
vi.mock("@/components/areas/ModelPicker", () => ({ ModelCombobox: () => null }));
let schedules = schedulesFixture();
let away = awayFixture();
let qc: QueryClient;
let decisions = { count: 0, entries: [] };
let runs: Record<string, unknown> = {};
let admin = true;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <AccessProvider value={{ role: admin ? "admin" : "adult", capabilities: admin ? ["admin", "work.use", "hermes.chat"] : ["work.use"], modules: [] }}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </AccessProvider>
  );
}
beforeEach(() => {
  nav.search = "";
  nav.replace.mockClear();
  schedules = schedulesFixture();
  away = awayFixture();
  decisions = { count: 0, entries: [] };
  runs = {};
  admin = true;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path === "/api/agents/schedules") return structuredClone(schedules);
    if (path === "/api/agents/away") return structuredClone(away);
    if (path === "/api/work/decisions") return decisions;
    if (path === "/api/work/agent-runs") return { items: runs, active: [] };
    if (path.startsWith("/api/work/activity")) return { items: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(api, "patch").mockImplementation(async (path, data) => {
    const job = schedules.jobs.find((j) => path.endsWith(j.id));
    if (job) Object.assign(job, data);
    return { job };
  });
  vi.spyOn(api, "post").mockImplementation(async (path) => {
    if (path.endsWith("/dismiss")) away = structuredClone(EMPTY_AWAY);
    return { ok: true };
  });
  vi.spyOn(api, "del").mockImplementation(async (path) => {
    schedules.jobs = schedules.jobs.filter((j) => !path.endsWith(j.id));
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.restoreAllMocks();
});

it("shows skipped chores as distinct outcomes even when no agent ran", async () => {
  away = skylightTaskUxFixture().away;
  render(<WhileAwayCard />, { wrapper });
  const card = await screen.findByTestId("while-away");
  expect(within(card).getByText("1 chore completed")).toBeDefined();
  expect(within(card).getByText("1 chore skipped")).toBeDefined();
  const rows = within(card).getAllByTestId("away-chore");
  expect(rows.map((r) => r.textContent)).toEqual(["CompletedCompleted kitchen routineSkylight", "SkippedSkipped routine, not completedSkylight"]);
  expect(within(card).queryByText("0 ran")).toBeNull();
});

it("renders schedules, status, next run and disabled templates", async () => {
  render(<ScheduledJobsCard />, { wrapper });
  expect(await screen.findByText("Lantern morning check")).toBeTruthy();
  expect(screen.getByText("Daily 08:30")).toBeTruthy();
  expect(screen.getByText(/^Next .*08:30/)).toBeTruthy();
  expect(screen.getByText("Done")).toBeTruthy();
  expect(screen.getAllByRole("switch").map((e) => (e as HTMLInputElement).checked)).toEqual([false, false, true]);
});

it("flips enable immediately before PATCH resolves, then reads back", async () => {
  const job = schedules.jobs[0];
  let finish!: () => void;
  vi.mocked(api.patch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          job.enabled = true;
          resolve({ job });
        };
      }),
  );
  render(<ScheduledJobsCard />, { wrapper });
  const toggle = await screen.findByRole("switch", { name: `Enable ${job.title}` });
  fireEvent.click(toggle);
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(api.patch).toHaveBeenCalledWith(`/api/agents/schedules/${job.id}`, { enabled: true });
  await act(async () => finish());
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
});

it("requires pause confirmation, supports cancel and Undo", async () => {
  render(<ScheduledJobsCard />, { wrapper });
  const toggle = await screen.findByRole("switch", { name: "Enable Lantern morning check" });
  fireEvent.click(toggle);
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((toggle as HTMLInputElement).checked).toBe(true);
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Pause job" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith("/api/agents/schedules/job_lantern", { enabled: true }));
});

it("never runs before confirmation and explains a 409", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, "limit", "daily_cap"));
  render(<ScheduledJobsCard />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "More for scheduled job Lantern morning check" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Run now…" }));
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByText(/Runs once now on your Hermes subscription/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run now" }));
  await screen.findByText("Daily limit reached");
  expect(api.post).toHaveBeenCalledWith("/api/agents/schedules/job_lantern/run", { confirm: true });
});

it("creates off by default, preserves multiline custom prompts and disables AI-excluded areas", async () => {
  render(<ScheduledJobsCard />, { wrapper });
  await screen.findByText("Lantern morning check");
  fireEvent.click(screen.getByRole("button", { name: "New job" }));
  const dialog = within(screen.getByRole("dialog"));
  expect((dialog.getByRole("switch", { name: "Job enabled" }) as HTMLInputElement).checked).toBe(false);
  expect((dialog.getByRole("option", { name: "Private journal (AI off)" }) as HTMLOptionElement).disabled).toBe(true);
  // Owner decision 2026-11-07: Finance is a normal area for scheduled jobs (Propose only by default).
  expect((dialog.getByRole("option", { name: "Finance" }) as HTMLOptionElement).disabled).toBe(false);
  fireEvent.change(dialog.getByLabelText("Job title"), { target: { value: "New check" } });
  fireEvent.change(dialog.getByLabelText("Job kind"), { target: { value: "triage" } });
  expect((dialog.getByLabelText("Job prompt") as HTMLTextAreaElement).value).toContain("Inbox");
  fireEvent.change(dialog.getByLabelText("Job prompt"), { target: { value: "My prompt\nSecond line" } });
  fireEvent.keyDown(dialog.getByLabelText("Job prompt"), { key: "Enter" });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(dialog.getByLabelText("Job kind"), { target: { value: "review" } });
  expect((dialog.getByLabelText("Job prompt") as HTMLTextAreaElement).value).toBe("My prompt\nSecond line");
  fireEvent.click(dialog.getByRole("button", { name: "Save job" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/api/agents/schedules",
      expect.objectContaining({ title: "New check", enabled: false, prompt: "My prompt\nSecond line" }),
    ),
  );
});

it("deletes only on confirmation and re-POSTs only input fields for Undo", async () => {
  render(<ScheduledJobsCard />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "More for scheduled job Lantern morning check" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  expect(api.del).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete job" }));
  const undo = await screen.findByRole("button", { name: "Undo" });
  await waitFor(() => expect(screen.queryByText("Lantern morning check")).toBeNull());
  fireEvent.click(undo);
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith("/api/agents/schedules", expect.objectContaining({ title: "Lantern morning check", enabled: true })),
  );
  expect(Object.keys(vi.mocked(api.post).mock.calls[0][1] as object).sort()).toEqual(["areaId", "enabled", "kind", "overnight", "prompt", "schedule", "title"]);
});

it("filters by area with a removable chip", async () => {
  nav.search = "area=area_lantern";
  render(<ScheduledJobsCard />, { wrapper });
  await screen.findByText("Area: Lantern workshop");
  expect(screen.getAllByTestId("scheduled-job")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove Area: Lantern workshop" }));
  expect(nav.replace).toHaveBeenCalledWith("/settings/agents#schedules");
});

it("hides an empty digest and does not fetch it for non-owners", async () => {
  away = structuredClone(EMPTY_AWAY);
  const view = render(<WhileAwayCard />, { wrapper });
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/agents/away"));
  expect(screen.queryByTestId("while-away")).toBeNull();
  view.unmount();
  qc.clear();
  vi.mocked(api.get).mockClear();
  admin = false;
  qc.setQueryData(["away"], awayFixture());
  render(<WhileAwayCard />, { wrapper });
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByTestId("while-away")).toBeNull();
});

it("renders digest counts, silent/failed runs, attribution and report/decision links", async () => {
  render(<WhileAwayCard />, { wrapper });
  const card = within(await screen.findByTestId("while-away"));
  expect(card.getByText("3 ran")).toBeTruthy();
  expect(card.getByText("1 failed")).toBeTruthy();
  expect(card.getByText("Nothing new")).toBeTruthy();
  expect(card.getByText("Skipped: deploy (Jarvis never deploys)")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "1 change" }));
  expect(card.getByText("by @devchief")).toBeTruthy();
  expect(card.getByRole("link", { name: "Added workshop notes" }).getAttribute("href")).toBe("/areas?item=note_lantern");
  expect(card.getByRole("link", { name: "1 needs you" }).getAttribute("href")).toBe("/decisions");
});

it("dismisses optimistically across views and restores on failure", async () => {
  let reject!: (e: Error) => void;
  vi.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  render(
    <>
      <WhileAwayCard />
      <WhileAwayCard compact />
    </>,
    { wrapper },
  );
  await screen.findAllByTestId("while-away");
  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss while you were away" })[0]);
  await waitFor(() => expect(screen.queryAllByTestId("while-away")).toHaveLength(0));
  expect(api.post).toHaveBeenCalledWith("/api/agents/away/dismiss");
  await act(async () => reject(new Error("Offline")));
  await waitFor(() => expect(screen.getAllByTestId("while-away")).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss while you were away" })[0]);
  await waitFor(() => expect(screen.queryAllByTestId("while-away")).toHaveLength(0));
});

it.each(["Finance", "Financial planning", "Excluded workshop"])("locks autonomy when %s is AI-excluded", (title) => {
  render(<AreaAutonomy area={{ id: "a", title, settings: { ...DEFAULT_AREA_SETTINGS, aiPolicy: "excluded" } }} value="propose" onChange={vi.fn()} />);
  expect(screen.getByText("AI off for this area")).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Autonomy" })).toBeNull();
});

it("saves area autonomy through the existing settings PATCH", async () => {
  const area = { id: "area_lantern", title: "Lantern workshop", settings: { ...DEFAULT_AREA_SETTINGS } } as WorkItem;
  render(<AreaSettingsDialog area={area} open onClose={vi.fn()} />, { wrapper });
  fireEvent.click(screen.getByRole("radio", { name: "Act on low-risk" }));
  expect(screen.getByText(/Never settles, merges, deploys, spends or sends/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save area settings" }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/work/items/area_lantern", { settings: { ...DEFAULT_AREA_SETTINGS, autonomy: "low_risk" } }));
});

it("uses the away line but never displaces pending decisions or failing runs", async () => {
  const { result } = renderHook(() => useCoordinatorThings(), { wrapper });
  await waitFor(() => expect(result.current.line.text).toBe(away.line));
  expect(result.current.line.tone).toBe("warn");
  expect(result.current.awayLine).toBe(true);
  decisions = { count: 1, entries: [] };
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ["work", "decisions"] });
  });
  await waitFor(() => expect(result.current.line.text).toBe("1 thing needs you"));
  expect(result.current.awayLine).toBe(false);
  runs = { failed: { itemId: "failed", title: "Failing run", live: "failed", liveAt: "", prs: [] } };
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ["work", "agent-runs"] });
  });
  await waitFor(() => expect(result.current.line.text).toBe("1 run needs attention"));
  expect(result.current.line.tone).toBe("bad");
});

it.each([
  ["ai_off", "AI is off for this area"],
  ["daily_cap", "Daily limit reached"],
  ["already_running", "This job is already running"],
  ["not_ready", "Pick an area first and set its coordinator agent"],
  ["too_many_jobs", "Job limit reached. Delete a job before adding another."],
])("explains %s without leaking server detail", (code, message) => {
  expect(scheduleError(new ApiError(409, "Internal detail", code))).toBe(message);
});

it("rolls back a failed enable and keeps the latest pause override when an older enable finishes", async () => {
  const job = schedules.jobs[0];
  vi.mocked(api.patch).mockRejectedValueOnce(new Error("Offline"));
  render(<ScheduledJobsCard />, { wrapper });
  const toggle = await screen.findByRole("switch", { name: `Enable ${job.title}` });
  fireEvent.click(toggle);
  expect((toggle as HTMLInputElement).checked).toBe(true);
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  let finish!: () => void;
  vi.mocked(api.patch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          job.enabled = true;
          resolve({ job });
        };
      }),
  );
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect((toggle as HTMLInputElement).checked).toBe(false);
  await act(async () => finish());
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Pause job" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((toggle as HTMLInputElement).checked).toBe(false);
});

it("validates weekly days before saving and preserves the chosen day/time", async () => {
  render(<ScheduledJobsCard />, { wrapper });
  await screen.findByText("Lantern morning check");
  fireEvent.click(screen.getByRole("button", { name: "New job" }));
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Weekly workshop" } });
  fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
  fireEvent.click(screen.getByRole("button", { name: "Save job" }));
  expect(screen.getByRole("alert").textContent).toBe("Pick at least one day");
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Fri" }));
  expect(screen.getByRole("button", { name: "Fri" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(screen.getByLabelText("Job time"), { target: { value: "15:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save job" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/api/agents/schedules",
      expect.objectContaining({ schedule: { freq: "weekly", time: "15:00", days: [5] }, enabled: false }),
    ),
  );
});

it("imports validated JSON and exposes a direct JSON export", async () => {
  vi.mocked(api.post).mockResolvedValueOnce({ created: 1, skipped: [{ title: "Duplicate", reason: "Already exists" }] });
  render(<ScheduledJobsCard />, { wrapper });
  await screen.findByText("Lantern morning check");
  const payload = {
    version: 1,
    exportedAt: "2026-11-07T12:00:00.000Z",
    jobs: [{ title: "Imported", areaTitle: null, kind: "custom", prompt: "Check", schedule: { freq: "daily", time: "08:30", days: [] }, overnight: false }],
  };
  const input = screen.getByLabelText("Import scheduled jobs");
  fireEvent.change(input, { target: { files: [{ text: async () => JSON.stringify(payload) }] } });
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/agents/schedules/import", jobsExportSchema.parse(payload)));
  const link = screen.getByRole("link", { name: "Export scheduled jobs" });
  expect(link.getAttribute("href")).toBe("/api/agents/schedules/export");
  expect(link.hasAttribute("download")).toBe(true);
  vi.mocked(api.post).mockClear();
  fireEvent.change(input, { target: { files: [{ text: async () => "not json" }] } });
  await act(async () => {});
  expect(api.post).not.toHaveBeenCalled();
});

it("shows running and skipped states, omits closed decisions and zero count chips", async () => {
  away = awayFixture();
  away.runs = [
    { ...away.runs[0], status: "running", changes: [], decisions: [], refused: [], summary: null },
    { ...away.runs[1], status: "skipped", silent: false, changes: [], decisions: [{ ...away.runs[0].decisions[0], open: false }] },
  ];
  away.counts = { ran: 0, failed: 0, changes: 0, needsYou: 0, running: 1, waiting: 0 };
  render(<WhileAwayCard />, { wrapper });
  await screen.findByTestId("while-away");
  expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Skipped" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /needs you/ })).toBeNull();
  expect(document.querySelectorAll(".k-pill")).toHaveLength(0);
});
