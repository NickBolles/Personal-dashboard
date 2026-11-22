// @vitest-environment jsdom
/**
 * Suggestions on the agent surface (task threads G1-G5, H2, H5): a proposed card says who, the title and why, with
 * Start, Not now and Why this? (the evidence and exactly what Start does). Started, it is the done card with Undo.
 * Not now leaves a line with Undo. And a coordinator's start in a chat is a done card, not a chip.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Suggestion } from "@/lib/suggestions";
import type { ChatAction } from "@/lib/chat/actions";
import { ActionsTaken } from "@/components/chat/ActionsTaken";
import { Suggestions } from "./Suggestions";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => "/resume" }));

let client: QueryClient;
let list: Suggestion[];
let posts: { path: string; body: unknown }[];
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <ToastProvider>{children}</ToastProvider>
  </QueryClientProvider>
);
const card = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "sug_1",
  channelId: "wk_home",
  channelTitle: "Home",
  who: "Home coordinator",
  topic: "next_step",
  act: "start",
  itemId: null,
  itemTitle: null,
  title: "Schedule the furnace service visit",
  why: "Two of three steps are done and the filter arrived Tuesday.",
  brief: "Book a service visit before the cold week.",
  evidence: [{ id: "wk_filter", title: "Buy the furnace filter" }],
  state: "open",
  createdAt: "2026-11-21T10:00:00Z",
  more: 0,
  ...over,
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  list = [card()];
  posts = [];
  nav.push.mockClear();
  vi.spyOn(api, "get").mockImplementation(async (path: string) => {
    if (path.startsWith("/api/work/suggestions?")) return { suggestions: list };
    if (path.startsWith("/api/work/suggestions/")) return { suggestion: list[0] ?? null };
    throw new Error(`unexpected ${path}`);
  });
  vi.spyOn(api, "post").mockImplementation(async (path: string, body?: unknown) => {
    posts.push({ path, body });
    const action = (body as { action?: string } | undefined)?.action;
    if (action === "start") {
      list = [
        card({
          state: "started",
          result: { itemId: "wk_new", title: "Schedule the furnace service visit", href: "/areas?item=wk_new&tab=chat", undoable: true, at: "now" },
        }),
      ];
    } else if (action === "not_now") list = [];
    else if (action === "show_again" || action === "undo") list = [card()];
    return { suggestion: list[0] ?? null } as never;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a suggestion card", () => {
  it("says who, the title and why; Why this? shows the evidence and exactly what Start does", async () => {
    render(<Suggestions scope="all" />, { wrapper });
    const el = await screen.findByTestId("suggestion");
    expect(el.getAttribute("data-variant")).toBe("proposed");
    expect(within(el).getByText("Home coordinator suggests")).toBeTruthy();
    expect(within(el).getByRole("heading", { name: "Schedule the furnace service visit" })).toBeTruthy();
    expect(within(el).getByText(/filter arrived Tuesday/)).toBeTruthy();
    fireEvent.click(within(el).getByRole("button", { name: "Why this?" }));
    expect(within(el).getByText("From: Buy the furnace filter")).toBeTruthy();
    expect(within(el).getByText("Creates “Schedule the furnace service visit” in Home and starts it with:")).toBeTruthy();
    expect(within(el).getByText("Book a service visit before the cold week.")).toBeTruthy();
    expect(within(el).getByRole("button", { name: "Don’t suggest this" })).toBeTruthy();
  });

  it("Start turns it into the done card with Open task and Undo", async () => {
    render(<Suggestions scope="all" />, { wrapper });
    fireEvent.click(within(await screen.findByTestId("suggestion")).getByRole("button", { name: "Start" }));
    const done = await screen.findByTestId("suggestion-done");
    expect(done.getAttribute("data-variant")).toBe("done");
    expect(posts[0]).toEqual({ path: "/api/work/suggestions/sug_1", body: { action: "start" } });
    fireEvent.click(within(done).getByRole("button", { name: "Open task" }));
    expect(nav.push).toHaveBeenCalledWith("/areas?item=wk_new&tab=chat");
    fireEvent.click(within(done).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: "/api/work/suggestions/sug_1", body: { action: "undo" } }));
  });

  it("Not now leaves a line with Undo, which shows it again", async () => {
    render(<Suggestions scope="all" />, { wrapper });
    fireEvent.click(within(await screen.findByTestId("suggestion")).getByRole("button", { name: "Not now" }));
    const line = await screen.findByText("Hidden for a week");
    await waitFor(() => expect(screen.queryByTestId("suggestion")).toBeNull());
    fireEvent.click(within(line.closest("p")!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts.at(-1)?.body).toEqual({ action: "show_again" }));
    expect(await screen.findByTestId("suggestion")).toBeTruthy();
  });

  it("a steer says Send", async () => {
    list = [card({ act: "steer", itemId: "wk_lumber", itemTitle: "Price lumber", title: "Use last month's list" })];
    render(<Suggestions scope="all" />, { wrapper });
    expect(within(await screen.findByTestId("suggestion")).getByRole("button", { name: "Send" })).toBeTruthy();
  });
});

describe("in a coordinator's chat", () => {
  const action = (over: Partial<ChatAction>): ChatAction => ({
    id: "t1:task_started",
    kind: "task_started",
    label: "Started",
    title: "Audit preview deployments",
    itemId: "wk_audit",
    runId: null,
    undoOpId: "op_start",
    href: "/areas?item=wk_audit&tab=chat",
    at: null,
    ...over,
  });

  it("a task the reply created and started is one done card, and Undo undoes both", async () => {
    render(
      <ActionsTaken
        actions={[
          action({ id: "t0:created", kind: "created", label: "Created", undoOpId: "op_create" }),
          action({}),
          action({ id: "t2:note", kind: "note", label: "Note", undoOpId: null }),
        ]}
      />,
      { wrapper },
    );
    const el = screen.getByTestId("task-card");
    expect(el.getAttribute("data-variant")).toBe("done");
    expect(within(el).getByText("Created a task")).toBeTruthy();
    // The other action stays a chip.
    expect(screen.getByTestId("actions-taken").textContent).toContain("Added a note");
    expect(screen.getByTestId("actions-taken").textContent).not.toContain("Created");
    fireEvent.click(within(el).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/work/ops/op_start/undo", "/api/work/ops/op_create/undo"]));
  });

  it("Not now on a card in a chat leaves the line with Undo there too", async () => {
    render(<ActionsTaken actions={[action({ id: "t4:suggested", kind: "suggested", label: "Suggested", undoOpId: null, suggestionId: "sug_1" })]} />, {
      wrapper,
    });
    fireEvent.click(within(await screen.findByTestId("suggestion")).getByRole("button", { name: "Not now" }));
    const line = await screen.findByText("Hidden for a week");
    fireEvent.click(within(line.closest("p")!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(posts.at(-1)?.body).toEqual({ action: "show_again" }));
    expect(await screen.findByTestId("suggestion")).toBeTruthy();
  });

  it("a suggestion a coordinator left in the chat is read back and drawn as its card", async () => {
    render(<ActionsTaken actions={[action({ id: "t3:suggested", kind: "suggested", label: "Suggested", undoOpId: null, suggestionId: "sug_1" })]} />, {
      wrapper,
    });
    expect(within(await screen.findByTestId("suggestion")).getByRole("button", { name: "Start" })).toBeTruthy();
  });
});
