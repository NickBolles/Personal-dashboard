// @vitest-environment jsdom
/**
 * The task list (task threads, step 3): one row per task, on In flight, All and the review queue. What a row
 * says and does, the timeline opened in place, an answer from the row, Stop, Mark reviewed and Add a task.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import { api } from "@/lib/client/api";
import { takeFirstRun } from "@/lib/client/first-run";
import { taskFixture } from "@/e2e/fixtures/tasks";
import { InFlightView } from "./InFlightView";
import { ReviewQueue } from "./ReviewQueue";
import { TaskList } from "./TaskList";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => "/resume",
}));
vi.mock("@/components/access", () => ({ useAccess: () => ({ capabilities: ["work.use", "hermes.chat"], can: () => true, isAdmin: true }) }));
vi.mock("@/lib/client/idb", () => ({
  kvGet: vi.fn(async () => undefined),
  kvSet: vi.fn(async () => undefined),
  kvDel: vi.fn(async () => undefined),
  rememberSession: vi.fn(),
}));
// The task's chat has its own tests; here it only has to be the thing docked beside the list.
vi.mock("@/components/work/TaskChat", () => ({ TaskChat: (p: { d: { item: { id: string } } }) => <div data-testid="thread" data-task={p.d.item.id} /> }));

const NOW = Date.parse("2026-11-21T18:30:00Z");
let fixture: ReturnType<typeof taskFixture>;
let client: QueryClient;
let posts: { path: string; body: unknown }[];
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
const row = (title: string) =>
  screen.getAllByTestId("task-row").find((el) => within(el).queryAllByText(title).length && !el.querySelector('[data-testid="task-row"]'))!;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  fixture = taskFixture(NOW);
  nav.search = "";
  nav.replace.mockClear();
  nav.push.mockClear();
  posts = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "get").mockImplementation(async (path: string) => {
    if (path.startsWith("/api/work/tasks?")) return fixture.lists[new URLSearchParams(path.split("?")[1]).get("view") as "flight"];
    if (path.endsWith("/timeline")) return { moments: fixture.timeline };
    if (path === "/api/work/items")
      return {
        items: [
          { id: "area_home", parentId: null, title: "Home", archived: false },
          { id: "area_portfolio", parentId: null, title: "Portfolio", archived: false },
        ],
        linkedConversations: [],
      };
    if (path.startsWith("/api/work/items/")) return { item: { id: path.split("/").pop(), title: "Reconcile the storefront inventory export" } };
    throw new Error(`unexpected GET ${path}`);
  });
  vi.spyOn(api, "post").mockImplementation(async (path: string, body?: unknown) => {
    posts.push({ path, body });
    if (path.endsWith("/answer")) return { decision: {}, op: { id: "op_answer", kind: "edit", label: "Saved" } };
    if (path === "/api/work/tasks/review")
      return {
        reviewed: [{ id: "task_theme", opId: "op_1" }],
        skipped: [{ id: "task_wall", title: "Measure the wall", reason: "Record its validation first" }],
      };
    if (path === "/api/work/items") return { item: { id: "task_new", title: (body as { title: string }).title } };
    if (path.endsWith("/chat")) return { sessionId: "sess_new", created: true };
    if (path.endsWith("/runs")) return { id: "run_1" };
    return {};
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a row", () => {
  it("says its state with the reason and who has it, then its title, then the latest activity with the one before", async () => {
    render(<TaskList scope="all" view="flight" />, { wrapper });
    await screen.findByText("Compare standing desk frames");
    expect(screen.getAllByTestId("task-group").map((g) => g.getAttribute("aria-label"))).toEqual(["Home", "Portfolio"]);
    expect(row("Compare standing desk frames").textContent).toContain("Needs you · 2h · @homechief");
    expect(row("Price lumber for the garage shelving").textContent).toMatch(/Stalled · no word since \d{2}:\d{2} · @homechief/);
    expect(row("Checkout refactor: smoke tests").textContent).toContain("Failed · 49m");
    const working = row("Reconcile the storefront inventory export");
    expect(working.textContent).toContain("Working · 6m · @devchief");
    // The title opens the task on its Overview.
    expect(within(working).getByRole("link", { name: "Reconcile the storefront inventory export" }).getAttribute("href")).toBe("/areas?item=task_inventory");
    // The activity line carries the latest report and the one before it.
    const peek = within(working).getByRole("button", { name: /^Timeline for Reconcile/ });
    expect(peek.textContent).toContain("40 mismatches so far, all in one category");
    expect(peek.textContent).toContain("Matched 172 of 212 rows");
    // Only "Working" moves, and no run number is shown.
    expect([...document.querySelectorAll(".chat-work-shimmer")].map((el) => el.textContent)).toEqual(["Working"]);
    expect(screen.getByTestId("task-list").textContent).not.toMatch(/\bR-\d+\b/);
    expect(within(row("Compare standing desk frames")).getByRole("img", { name: "Decision D 52" })).toBeTruthy();
  });

  it("shows its icon actions in a fixed order: Steer, then Stop or Retry", async () => {
    render(<TaskList scope="all" view="flight" />, { wrapper });
    await screen.findByText("Compare standing desk frames");
    const actions = (title: string) =>
      within(row(title))
        .getAllByRole("button")
        .map((b) => b.textContent ?? "")
        .filter((t) => /^(Steer|Stop|Retry|Resume) /.test(t))
        .map((t) => t.split(" ")[0]);
    expect(actions("Reconcile the storefront inventory export")).toEqual(["Steer", "Stop"]);
    expect(actions("Price lumber for the garage shelving")).toEqual(["Steer", "Resume"]);
    expect(actions("Checkout refactor: smoke tests")).toEqual(["Retry"]);
    // Steer and Retry open the task's chat with the composer ready; nothing is sent from the list.
    fireEvent.click(within(row("Reconcile the storefront inventory export")).getByRole("button", { name: /^Steer / }));
    expect(nav.push).toHaveBeenLastCalledWith("/areas?item=task_inventory&tab=chat&compose=1");
    fireEvent.click(within(row("Checkout refactor: smoke tests")).getByRole("button", { name: /^Retry / }));
    expect(nav.push).toHaveBeenLastCalledWith("/areas?item=task_smoke&tab=chat&draft=retry");
    expect(posts).toEqual([]);
  });

  it("opens the timeline in place, newest first, each line with its type and time", async () => {
    render(<TaskList scope="all" view="flight" />, { wrapper });
    await screen.findByText("Compare standing desk frames");
    const working = row("Reconcile the storefront inventory export");
    fireEvent.click(within(working).getByRole("button", { name: /^Timeline for Reconcile/ }));
    const list = await within(working).findByRole("list", { name: "Timeline for Reconcile the storefront inventory export" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^Progress40 mismatches so far, all in one category\d{2}:\d{2}$/),
      expect.stringMatching(/^Step doneMatched 172 of 212 rows/),
      expect.stringMatching(/^StartedFrom your message in Chat/),
      expect.stringMatching(/^CapturedBy you/),
    ]);
    expect(within(working).getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/areas?item=task_inventory");
    // The same control closes it again.
    fireEvent.click(within(working).getByRole("button", { name: /^Timeline for Reconcile/ }));
    expect(within(working).queryByRole("list")).toBeNull();
  });

  it("answers a question with two short choices from the row, and leaves a receipt with Undo", async () => {
    render(<TaskList scope="all" view="flight" />, { wrapper });
    const asking = row((await screen.findByText("Compare standing desk frames")).textContent!);
    await act(async () => {
      fireEvent.click(within(asking).getByRole("button", { name: "$350" }));
    });
    await waitFor(() => expect(posts.some((p) => p.path === "/api/coordinator/decisions/D-52/answer")).toBe(true));
    expect(posts.find((p) => p.path.endsWith("/answer"))!.body).toMatchObject({ answer: "$350" });
    const receipt = await within(row("Compare standing desk frames")).findByRole("status");
    expect(receipt.textContent).toContain("Answered: $350");
    await act(async () => {
      fireEvent.click(within(receipt).getByRole("button", { name: "Undo" }));
    });
    await waitFor(() => expect(posts.some((p) => p.path === "/api/work/ops/op_answer/undo")).toBe(true));
  });

  it("anything else is Answer, which opens the task at the question", async () => {
    fixture.lists.flight.groups[0]!.rows[0]!.question!.choices = ["Flexidesk E7", "Uplift V2", "Neither"];
    render(<TaskList scope="all" view="flight" />, { wrapper });
    const asking = row((await screen.findByText("Compare standing desk frames")).textContent!);
    expect(within(asking).queryByRole("button", { name: "Flexidesk E7" })).toBeNull();
    expect(within(asking).getByRole("link", { name: "Answer" }).getAttribute("href")).toBe("/areas?item=task_desk#ip-next-h");
  });

  it("Stop asks first, in place, then stops the work on the task", async () => {
    render(<TaskList scope="all" view="flight" />, { wrapper });
    await screen.findByText("Compare standing desk frames");
    const working = row("Reconcile the storefront inventory export");
    fireEvent.click(within(working).getByRole("button", { name: /^Stop / }));
    expect(posts).toEqual([]);
    const confirm = within(working).getByRole("group", { name: "Stop work on Reconcile the storefront inventory export?" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Stop" }));
    });
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/work/items/task_inventory/stop"]));
  });
});

describe("the lists", () => {
  it("In flight ends with finished work as one row with a count and the oldest age, and what closed since the last look", async () => {
    render(<TaskList scope="all" view="flight" />, { wrapper });
    const review = await screen.findByTestId("review-row");
    expect(review.textContent).toContain("Ready for review · 2");
    expect(review.textContent).toContain("Across 2 projects · oldest 9 days");
    expect(within(review).getByRole("link").getAttribute("href")).toBe("/resume/review");
    expect(screen.getByTestId("done-row").textContent).toContain("Done since you looked · 3Recipe box dedupe · Car registration · 1 more");
    expect(screen.getAllByTestId("task-row")).toHaveLength(4);
  });

  it("All shows a project as one row that rolls up what is inside and opens in place", async () => {
    fixture.rows.inventory.tags = ["inventory"];
    render(<TaskList scope="all" view="all" />, { wrapper });
    await screen.findByText("Storefront");
    const project = screen.getAllByTestId("task-row").find((el) => el.getAttribute("data-task") === "proj_store")!;
    expect(project.textContent).toContain("Project · 3 of 10 done · 1 failed · 1 working · 1 to review");
    expect(within(project).queryAllByTestId("task-row")).toHaveLength(0);
    fireEvent.click(within(project).getByRole("button", { name: "Tasks in Storefront" }));
    const inside = within(project).getAllByTestId("task-row");
    expect(inside.map((el) => el.getAttribute("data-task"))).toEqual(["task_smoke", "task_inventory", "task_theme", "task_sale"]);
    expect(inside[3]!.textContent).toContain("Not started · captured 3d ago");
    // Work nothing has touched names nobody, unless it has its own assignee; tags stay addressable on the row.
    expect(inside[3]!.querySelector("[data-assignee]")).toBeNull();
    expect(inside[1]!.querySelector('[data-tag="inventory"]')?.textContent).toContain("#inventory");
    expect(inside[2]!.textContent).toContain("Ready for review");
    // Finished work can be sent back from its row.
    expect(within(inside[2]!).getByRole("button", { name: "Send back Quieter stalled-run notices" })).toBeTruthy();
  });

  it("an empty list says so in one line", async () => {
    fixture.lists.flight = { ...fixture.lists.flight, groups: [], review: null, done: null };
    render(<TaskList scope="all" view="flight" empty={<p>Nothing in flight</p>} />, { wrapper });
    expect(await screen.findByText("Nothing in flight")).toBeTruthy();
    expect(screen.queryAllByTestId("task-row")).toHaveLength(0);
  });
});

describe("In flight page", () => {
  it("has one heading and keeps the view in the URL", async () => {
    render(<InFlightView />, { wrapper });
    await screen.findByText("Compare standing desk frames");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["In flight"]);
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/resume?view=all", { scroll: false });
    cleanup();
    nav.search = "view=all&x=1";
    render(<InFlightView />, { wrapper });
    await screen.findByText("Storefront");
    fireEvent.click(screen.getByRole("radio", { name: "In flight" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/resume?x=1", { scroll: false });
  });

  it("Add a task creates it in the chosen channel and starts its chat with what was typed", async () => {
    render(<InFlightView />, { wrapper });
    await screen.findByText("Compare standing desk frames");
    const form = screen.getByTestId("add-task");
    expect((within(form).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Add a task"), { target: { value: "Sort out which preview deployments are still used" } });
    await waitFor(() => expect((within(form).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/areas?item=task_new&tab=chat"));
    expect(posts.map((p) => p.path)).toEqual(["/api/work/items", "/api/work/items/task_new/chat", "/api/hermes/sessions/sess_new/runs"]);
    expect(posts[0]!.body).toEqual({ kind: "thread", parentId: "area_home", title: "Sort out which preview deployments are still used" });
    expect(posts[2]!.body).toMatchObject({ input: "Sort out which preview deployments are still used" });
    // The thread picks the send up when it opens, so the message shows at once.
    expect(takeFirstRun("sess_new")?.input).toBe("Sort out which preview deployments are still used");
  });
});

describe("review queue", () => {
  it("groups by project with the result line and the pull request state", async () => {
    render(<ReviewQueue />, { wrapper });
    await screen.findByText("Quieter stalled-run notices");
    expect(screen.getByText("2 tasks · 2 projects")).toBeTruthy();
    expect(screen.getAllByTestId("task-group").map((g) => g.getAttribute("aria-label"))).toEqual(["Storefront", "Garage shelving"]);
    const first = row("Quieter stalled-run notices");
    expect(first.textContent).toContain("Notices fold after the first line");
    expect(first.textContent).toContain("PR 303 · merged");
    expect(row("Measure the wall").textContent).toContain("3.2 m clear, studs at 40 cm");
  });

  it("marks several reviewed behind one confirm, with Undo, and names what it left open", async () => {
    render(<ReviewQueue />, { wrapper });
    await screen.findByText("Quieter stalled-run notices");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const mark = () => screen.getByTestId("review-bar").querySelector("button") as HTMLButtonElement;
    expect(mark().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select Quieter stalled-run notices" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Measure the wall" }));
    expect(mark().textContent).toBe("Mark 2 reviewed");
    fireEvent.click(mark());
    // Nothing is closed before the confirm.
    expect(posts).toEqual([]);
    const dialog = screen.getByRole("dialog", { name: "Mark 2 tasks reviewed?" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Mark reviewed" }));
    });
    await waitFor(() => expect(posts).toEqual([{ path: "/api/work/tasks/review", body: { ids: ["task_theme", "task_wall"] } }]));
    const receipt = await screen.findByTestId("review-receipt");
    expect(receipt.textContent).toContain("1 task marked reviewed");
    expect(receipt.textContent).toContain("1 left open: Measure the wall (Record its validation first)");
    await act(async () => {
      fireEvent.click(within(receipt).getByRole("button", { name: "Undo" }));
    });
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/work/ops/op_1/undo"));
  });
});
