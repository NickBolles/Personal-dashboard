// @vitest-environment jsdom
/**
 * A task's Chat tab: the first message creates the task's chat, its other chats can be made primary, and the
 * primary chat is the shared thread.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { takeFirstRun } from "@/lib/client/first-run";
import type { WorkDetail, WorkItem, WorkLink } from "@/lib/work";
import { OtherChats, TaskChat, startedElsewhere } from "./TaskChat";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/areas" }));
vi.mock("@/lib/client/idb", () => ({
  kvGet: vi.fn(async () => undefined),
  kvSet: vi.fn(async () => undefined),
  kvDel: vi.fn(async () => undefined),
  rememberSession: vi.fn(),
}));
// The thread itself has its own tests: here it only has to be the one that is mounted for the primary chat.
vi.mock("@/components/chat/ChatThread", () => ({
  ChatThread: (p: { sessionId: string; frame: string; scroll: string; lead: ReactNode; prefill?: { text: string } }) => (
    <div data-testid="thread" data-session={p.sessionId} data-frame={p.frame} data-scroll={p.scroll} data-prefill={p.prefill?.text ?? ""}>
      {p.lead}
    </div>
  ),
}));

const at = "2026-11-20T10:00:00.000Z";
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "t1",
  parentId: "p1",
  kind: "thread",
  title: "Standing desk",
  summary: "Three frames shortlisted. Budget not set.",
  nextAction: "",
  status: "captured",
  sortOrder: 0,
  startDate: null,
  targetDate: null,
  completedAt: null,
  settledKind: null,
  settledReason: null,
  archived: false,
  builtIn: false,
  validationDefault: null,
  sessionId: null,
  primarySessionId: null,
  settings: null,
  tags: [],
  assignee: null,
  decision: null,
  createdAt: at,
  updatedAt: at,
  ...over,
});
const conv = (sessionId: string, title: string): WorkItem =>
  item({ id: `c_${sessionId}`, parentId: "t1", kind: "conversation", title, sessionId, summary: "" });
const chatLink = (sessionId: string, title: string): WorkLink => ({
  id: `l_${sessionId}`,
  itemId: "t1",
  kind: "chat_session",
  targetId: sessionId,
  url: null,
  title,
  role: "source",
  externalState: null,
  stateChangedAt: null,
  checkedAt: null,
  checkError: null,
  checksState: null,
  checksAt: null,
  lineage: null,
  packetId: null,
  createdAt: at,
});
const detail = (over: Partial<WorkDetail> = {}): WorkDetail => ({
  item: item(),
  breadcrumb: [],
  children: [],
  links: [],
  packets: [],
  validations: [],
  events: [{ id: "e1", itemId: "t1", kind: "created", fromStatus: null, toStatus: "captured", reason: "Captured from Inbox", actor: "u", source: null, at }],
  lineage: [],
  settle: { allowed: false, reason: null },
  validationDefault: { value: "optional", explicit: false, areaId: null, areaTitle: null },
  area: null,
  githubRefresh: false,
  blockedBy: [],
  blocking: [],
  ...over,
});

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path.startsWith("/api/agents/resolve")) return { requested: "homechief", profile: "homechief", routed: true, reason: "routed" };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

describe("a task with no chat yet", () => {
  it("shows what the task is and creates the chat with the first message, never before", async () => {
    const d = detail();
    client.setQueryData(["work", "item", "t1"], d);
    const post = vi.spyOn(api, "post").mockImplementation(async (path) => {
      if (path === "/api/work/items/t1/chat") return { sessionId: "sess-new", created: true };
      if (path === "/api/hermes/sessions/sess-new/runs") return { runId: "run-1", status: "running" };
      throw new Error(`Unexpected POST ${path}`);
    });
    render(<TaskChat d={d} scroll="window" onOp={() => undefined} />, { wrapper });
    expect(screen.getByTestId("task-no-chat")).toBeTruthy();
    expect(screen.getByText("Three frames shortlisted. Budget not set.")).toBeTruthy();
    expect(screen.getByText("Captured from Inbox")).toBeTruthy();
    expect(screen.queryByTestId("thread")).toBeNull();
    // Looking at the tab asks for nothing.
    expect(post).not.toHaveBeenCalled();
    const input = screen.getByTestId("task-first-input");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Price the three frames" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-first-send"));
    });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/hermes/sessions/sess-new/runs", expect.objectContaining({ input: "Price the three frames" })));
    // The chat is asked for first (no handoff: this was typed), and the task's cached detail now names it.
    expect(post.mock.calls[0]).toEqual(["/api/work/items/t1/chat", {}]);
    expect(client.getQueryData<WorkDetail>(["work", "item", "t1"])?.item.primarySessionId).toBe("sess-new");
    // The thread picks the send up from here when it mounts.
    expect(takeFirstRun("sess-new")?.input).toBe("Price the three frames");
  });

  it("a handoff put in the composer is sent as the first message and recorded with the chat it starts", async () => {
    const d = detail();
    const post = vi
      .spyOn(api, "post")
      .mockImplementation(async (path) =>
        path === "/api/work/items/t1/chat" ? { sessionId: "sess-h", created: true } : { runId: "run-2", status: "running" },
      );
    render(<TaskChat d={d} scroll="element" prefill={{ text: "# Handoff: Standing desk", at: 1, handoff: true }} onOp={() => undefined} />, { wrapper });
    const input = screen.getByTestId("task-first-input") as HTMLTextAreaElement;
    expect(input.value).toBe("# Handoff: Standing desk");
    expect(post).not.toHaveBeenCalled();
    // Docked beside Overview, the pane does not repeat the summary and the log that are already on screen.
    expect(screen.queryByText("Three frames shortlisted. Budget not set.")).toBeNull();
    expect(screen.queryByText("Captured from Inbox")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-first-send"));
    });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/work/items/t1/chat", { handoff: true }));
    takeFirstRun("sess-h");
  });

  it("a draft a list row opened the task with (Retry, Resume) is a plain first message, not a handoff", async () => {
    const post = vi
      .spyOn(api, "post")
      .mockImplementation(async (path) =>
        path === "/api/work/items/t1/chat" ? { sessionId: "sess-r", created: true } : { runId: "run-3", status: "running" },
      );
    render(<TaskChat d={detail()} scroll="element" prefill={{ text: "Try again from where it failed.", at: 2 }} onOp={() => undefined} />, { wrapper });
    expect((screen.getByTestId("task-first-input") as HTMLTextAreaElement).value).toBe("Try again from where it failed.");
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-first-send"));
    });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/work/items/t1/chat", {}));
    takeFirstRun("sess-r");
  });

  it("keeps the words when the chat could not be started", async () => {
    vi.spyOn(api, "post").mockRejectedValue(new Error("Hermes is not answering"));
    render(<TaskChat d={detail()} scroll="window" onOp={() => undefined} />, { wrapper });
    const input = screen.getByTestId("task-first-input") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Price the frames" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-first-send"));
    });
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(input.value).toBe("Price the frames");
    expect(screen.queryByTestId("thread")).toBeNull();
  });
});

describe("a task with a chat", () => {
  it("mounts the shared thread on the primary chat, embedded, with its other chats at the top", () => {
    const d = detail({
      item: item({ primarySessionId: "s-main" }),
      children: [conv("s-main", "Desk chat"), conv("s-old", "First look")],
      links: [chatLink("s-linked", "Loose notes")],
    });
    render(<TaskChat d={d} scroll="element" runSessions={["s-main", "s-coordinator", null]} prefill={{ text: "draft", at: 2 }} onOp={() => undefined} />, {
      wrapper,
    });
    const thread = screen.getByTestId("thread");
    expect(thread.getAttribute("data-session")).toBe("s-main");
    expect(thread.getAttribute("data-frame")).toBe("embedded");
    expect(thread.getAttribute("data-scroll")).toBe("element");
    expect(thread.getAttribute("data-prefill")).toBe("draft");
    expect(screen.queryByTestId("task-no-chat")).toBeNull();
    // Other chats: the two that are the task's own, and the coordinator's chat a run happened in (a link only).
    const others = within(thread).getByTestId("task-other-chats");
    fireEvent.click(within(others).getByRole("button", { name: /^Other chats/ }));
    expect(within(others).getByRole("link", { name: "First look" }).getAttribute("href")).toBe("/chat/s-old");
    expect(within(others).getByRole("link", { name: "Loose notes" }).getAttribute("href")).toBe("/chat/s-linked");
    expect(within(others).getByRole("link", { name: "Started in another chat" }).getAttribute("href")).toBe("/chat/s-coordinator");
    expect(within(others).getAllByRole("button", { name: "Make primary" })).toHaveLength(2);
    expect(within(others).queryByText("Desk chat")).toBeNull();
  });

  it("Make primary asks first, then swaps and hands back the undo", async () => {
    const onOp = vi.fn();
    const op = { id: "op1", kind: "primary_chat", label: "Primary chat changed" };
    const post = vi.spyOn(api, "post").mockResolvedValue({ item: item({ primarySessionId: "s-old" }), op });
    render(
      <OtherChats
        item={{ id: "t1", title: "Standing desk" }}
        others={[{ sessionId: "s-old", title: "First look", primary: false, source: "filed", at }]}
        startedIn={[]}
        onOp={onOp}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Other chats/ }));
    fireEvent.click(screen.getByRole("button", { name: "Make primary" }));
    // Nothing changes until it is confirmed.
    expect(post).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Make this the primary chat?" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Make primary" }));
    });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/work/items/t1/chat/primary", { sessionId: "s-old" }));
    await waitFor(() => expect(onOp).toHaveBeenCalledWith(op));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws nothing when the task has no other chats", () => {
    const { container } = render(<OtherChats item={{ id: "t1", title: "T" }} others={[]} startedIn={[]} onOp={() => undefined} />, { wrapper });
    expect(container.textContent).toBe("");
  });
});

describe("chats that agent runs happened in", () => {
  it("lists each session once and leaves out the task's own chats", () => {
    const d = detail({ item: item({ primarySessionId: "s-main" }), children: [conv("s-old", "First look")] });
    expect(startedElsewhere(d, ["s-main", "s-old", "s-cos", "s-cos", null, undefined])).toEqual(["s-cos"]);
  });
});
