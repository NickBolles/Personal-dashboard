// @vitest-environment jsdom
import { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { kvDel, kvSet } from "@/lib/client/idb";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { Conversation } from "./Conversation";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  clearFiles: vi.fn(),
  quickAdd: vi.fn(),
  jump: vi.fn(),
  active: false,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/client/session-lists", () => ({ refreshSessionLists: vi.fn(async () => undefined) }));
vi.mock("@/lib/client/idb", () => ({
  kvGet: vi.fn(async (key: string) => (key.startsWith("model:") ? { model: "chosen-model", provider: "chosen-provider" } : undefined)),
  kvSet: vi.fn(async () => undefined),
  kvDel: vi.fn(async () => undefined),
  rememberSession: vi.fn(),
}));
vi.mock("@/lib/client/keyboard", () => ({ useKeyboardInset: vi.fn() }));
vi.mock("./useFollowScroll", () => ({ useFollowScroll: () => ({ detached: false, jumpToLatest: mocks.jump }) }));
vi.mock("./useRunStream", () => ({
  useRunStream: () => ({
    state: { phase: "completed", text: "", activity: [] },
    active: mocks.active,
    start: mocks.start,
    clear: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock("./LinksPanel", () => ({ usePanelLinks: () => ({ links: [], patch: vi.fn() }) }));
vi.mock("./things/useChatThings", () => ({ useChatThings: () => ({ things: {}, markSeen: vi.fn() }) }));
vi.mock("./things/useChatPanelLayout", () => ({ useChatPanelLayout: () => ({ wide: false, open: false }) }));
vi.mock("./things/ChatPanel", () => ({ ChatPanel: () => null, ParentChatLink: () => null }));
vi.mock("./things/ChatTray", () => ({ ChatTray: ({ accessory }: { accessory: ReactNode }) => accessory }));
vi.mock("@/components/workflows/RunPanel", () => ({
  useWorkflowRun: () => ({
    id: "workflow",
    title: "Notes",
    status: "live",
    context: "Workflow context must not leak",
    capture: {},
    panel: [{ type: "QuickAddChips", props: { chips: [{ label: "Points", field: "points" }] } }],
  }),
  useAgentCapture: () => ({}),
  quickAdd: mocks.quickAdd,
}));
vi.mock("./Attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Attachments")>()),
  useChatAttachments: () => ({
    drafts: [{ localId: "staged", id: "file-staged", kind: "file", name: "draft.txt", size: 10, status: "ready", progress: 100 }],
    readyIds: ["file-staged"],
    uploading: false,
    clear: mocks.clearFiles,
    add: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
  }),
  useConversationFiles: () => ({ data: [] }),
  useFileDrop: () => ({ props: {}, over: false }),
}));
vi.mock("./ContextSheet", () => ({
  ContextSheet: ({ open, onToggle, onClose }: { open: boolean; onToggle: (chip: { label: string; ref: string }) => void; onClose: () => void }) =>
    open ? (
      <button
        onClick={() => {
          onToggle({ label: "Staged context", ref: "item:staged" });
          onClose();
        }}
      >
        Stage context
      </button>
    ) : null,
}));
// Host-level regression: the feedback dialog supplies an already confirmed plain prompt.
vi.mock("@/components/feedback/RateMessage", () => ({
  RateMessage: ({ onAskFix }: { onAskFix: (prompt: string) => Promise<boolean> }) => (
    <button onClick={() => void onAskFix("Fix this exact reply.")}>Ask to fix</button>
  ),
}));
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["session", "same-session"], {
    session: { id: "same-session", title: "Conversation", pinned: false, archived: false },
    timeline: [{ kind: "assistant", id: "rated", text: "Reply to correct" }],
    children: [],
    links: [],
  });
  vi.spyOn(api, "post").mockResolvedValue({ runId: "correction-run" });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
async function stageComposer() {
  render(
    <QueryClientProvider client={client}>
      <Conversation sessionId="same-session" />
    </QueryClientProvider>,
  );
  await screen.findByText("Model: chosen-model");
  const input = screen.getByRole("textbox", { name: "Message Hermes" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Keep this unsent draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Attach context" }));
  fireEvent.click(screen.getByRole("button", { name: "Stage context" }));
  fireEvent.click(screen.getByRole("button", { name: "Points" }));
  return input;
}
it("sends only the correction prompt to the same session without touching staged composer state", async () => {
  const input = await stageComposer();
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith("correction-run"));
  expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/same-session/runs", {
    input: "Fix this exact reply.",
    idempotencyKey: expect.stringMatching(/^fix-/),
    capabilities: [SMART_CAPABILITY],
    model: "chosen-model",
    provider: "chosen-provider",
  });
  expect(mocks.quickAdd).not.toHaveBeenCalled();
  expect(mocks.clearFiles).not.toHaveBeenCalled();
  expect(input.value).toBe("Keep this unsent draft");
  expect(screen.getByText("draft.txt")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove context Staged context" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Points" }).getAttribute("aria-pressed")).toBe("true");
  expect(kvSet).not.toHaveBeenCalledWith("pending:same-session", expect.anything());
  expect(kvDel).not.toHaveBeenCalled();
  expect(mocks.jump).toHaveBeenCalledWith(false, true);
});

it("a failed correction preserves the composer and does not start a run", async () => {
  const input = await stageComposer();
  vi.mocked(api.post).mockRejectedValue(new Error("Not connected"));
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(expect.stringContaining("/runs"), expect.anything()));
  expect(input.value).toBe("Keep this unsent draft");
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.quickAdd).not.toHaveBeenCalled();
  expect(mocks.clearFiles).not.toHaveBeenCalled();
});

it("blocks corrections while a reply is active", async () => {
  mocks.active = true;
  await stageComposer();
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }));
  expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining("/runs"), expect.anything());
  expect(mocks.start).not.toHaveBeenCalled();
});

it("shows a sent message as the person meant it, and keeps Copy on the text as it was sent", async () => {
  const viewing = "[Viewing: Today — /home]\nWhat changed overnight?";
  const receipt = 'Decision on "Rollout": Decision: Ship the rubric change now, or wait for the bisect? → Wait for the bisect';
  client.setQueryData(["session", "wrapped"], {
    session: { id: "wrapped", title: "Wrapped", pinned: false, archived: false, agentProfile: "chiefofstaff" },
    timeline: [
      { kind: "user", id: "u1", text: viewing },
      { kind: "assistant", id: "a1", text: "Nothing much." },
      { kind: "user", id: "u2", text: receipt },
    ],
    children: [],
    links: [],
  });
  const writeText = vi.fn(async (text: string) => void text);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(
    <QueryClientProvider client={client}>
      <Conversation sessionId="wrapped" />
    </QueryClientProvider>,
  );
  await screen.findByText("Model: chosen-model");
  const [typed, decided] = screen.getAllByTestId("msg-bubble").filter((b) => b.getAttribute("data-who") === "user");
  // The page context is a caption attached to the bubble, never part of the message text.
  expect(screen.getByTestId("msg-context").textContent).toBe("Sent while Viewing: Today");
  expect(typed.textContent).toBe("You said: What changed overnight?");
  // A one-tap decision reads as a receipt: what was decided, the answer, the question behind a disclosure.
  expect(decided.getAttribute("data-receipt")).toBe("decision");
  expect(decided.textContent).toContain("You decided · Rollout");
  expect(decided.querySelector("p.font-medium")?.textContent).toBe("Wait for the bisect");
  expect(decided.querySelector("details")?.open).toBe(false);
  expect(decided.querySelector("details")?.textContent).toContain("Ship the rubric change now, or wait for the bisect?");
  // The composer names whoever answers here, like the header does.
  expect(screen.getByRole("textbox", { name: "Message @chiefofstaff" }).getAttribute("placeholder")).toBe("Message @chiefofstaff…");
  const copies = screen.getAllByRole("button", { name: "Copy your message" });
  fireEvent.click(copies[0]);
  fireEvent.click(copies[1]);
  expect(writeText.mock.calls.map((c) => c[0])).toEqual([viewing, receipt]);
  Reflect.deleteProperty(navigator, "clipboard");
});
