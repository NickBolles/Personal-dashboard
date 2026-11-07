// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider, LoadingState } from "@/components/ui";
import { ActivityView } from "@/app/(shell)/settings/activity/ActivityView";
import { BrainView } from "@/app/(shell)/brain/BrainView";
import { PhonesView } from "@/app/(shell)/settings/phones/PhonesView";
import { PeopleView } from "@/app/(shell)/settings/people/PeopleView";
import { DriveConnection } from "@/components/integrations/DriveConnection";
import { BiblePackSettings } from "@/components/integrations/BiblePackSettings";
import { WorkoutView } from "@/app/(shell)/workouts/WorkoutView";

const state = vi.hoisted(() => ({
  query: { data: undefined as unknown, error: null as Error | null, isPending: true, isLoading: true, isError: false, refetch: vi.fn() },
  get: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => state.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/access", () => ({ useAccess: () => ({ can: () => true, isAdmin: false }) }));
vi.mock("@/components/capture/CaptureTokens", () => ({ CaptureTokens: () => null }));
vi.mock("@/lib/client/api", () => ({
  api: { get: (...args: unknown[]) => state.get(...args) },
  ApiError: class extends Error {},
  newIdempotencyKey: () => "state-test",
}));

beforeEach(() => {
  state.query = { data: undefined, error: null, isPending: true, isLoading: true, isError: false, refetch: vi.fn() };
  state.get.mockReset();
});
afterEach(cleanup);
const show = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);
function ready(data: unknown) {
  Object.assign(state.query, { data, isPending: false, isLoading: false });
}
function failed() {
  Object.assign(state.query, { error: new Error("State fixture unavailable"), isPending: false, isLoading: false, isError: true });
}

it("names skeleton loading for assistive tech and keeps its shapes decorative", () => {
  const { container } = render(<LoadingState label="Loading state fixture…" />);
  expect(screen.getByRole("status", { name: "Loading state fixture…" }).getAttribute("aria-busy")).toBe("true");
  expect(container.querySelectorAll('.k-skel[aria-hidden="true"]')).toHaveLength(3);
});
it("activity keeps its h1 during loading, uses the kit empty state and retries failures", () => {
  const view = show(<ActivityView />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Activity log");
  expect(screen.getByRole("status")).toBeTruthy();
  ready({ entries: [] });
  view.rerender(
    <ToastProvider>
      <ActivityView />
    </ToastProvider>,
  );
  expect(screen.getByText("Nothing yet.").closest(".k-empty")).not.toBeNull();
  failed();
  view.rerender(
    <ToastProvider>
      <ActivityView />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.query.refetch).toHaveBeenCalledOnce();
});
it("failed phone reads never claim no phones are paired", () => {
  failed();
  show(<PhonesView />);
  expect(screen.queryByText("No phones paired yet")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(2);
});
it("people render an empty state without duplicating the add action", () => {
  ready({ people: [] });
  show(<PeopleView />);
  expect(screen.getByText("No people yet").closest(".k-empty")).not.toBeNull();
  expect(screen.getAllByRole("button", { name: "Add someone" })).toHaveLength(1);
});
it("Brain handles partial upstream failure and successful empty lists independently", () => {
  ready({
    health: { ok: false, error: "offline" },
    jobs: { ok: true, items: [] },
    skills: { ok: true, items: [] },
    toolsets: { ok: false, error: "tools offline" },
  });
  show(<BrainView />);
  expect(screen.getByText("No scheduled jobs.").closest(".k-empty")).not.toBeNull();
  expect(screen.getByText("No skills available.").closest(".k-empty")).not.toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
  expect(state.query.refetch).toHaveBeenCalledOnce();
});
it.each([DriveConnection, BiblePackSettings])("connection panels stop loading on failure and expose Retry (%s)", (Panel) => {
  failed();
  show(<Panel />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("State fixture unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.query.refetch).toHaveBeenCalledOnce();
});
it("workout initial read failure stops the skeleton and Retry reads again without reloading or writing", async () => {
  state.get.mockRejectedValueOnce(new Error("Workout fixture unavailable")).mockResolvedValueOnce({ workouts: [] });
  show(<WorkoutView />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("status", { name: "Loading your private workouts…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Start workout" });
  expect(state.get.mock.calls).toEqual([["/api/workouts"], ["/api/workouts"]]);
});
