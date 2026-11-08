// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { CoordinatorThread, type CoordinatorResponse } from "./CoordinatorThread";

vi.mock("next/navigation", () => ({ usePathname: () => "/areas" }));
vi.mock("@/lib/client/session-lists", () => ({ refreshSessionLists: vi.fn(async () => undefined) }));
vi.mock("@/components/quick-actions/useQuickActions", () => ({ useQuickActions: () => ({ data: { actions: [] } }) }));
vi.mock("@/components/quick-actions/QuickActionChips", () => ({ QuickActionChips: () => null }));
vi.mock("@/components/quick-actions/ProposedQuickActions", () => ({ ProposedQuickActions: () => null }));
// Exercise the host's real send wiring without coupling this regression to rating persistence.
vi.mock("@/components/feedback/RateMessage", () => ({
  RateMessage: ({ onAskFix }: { onAskFix: (prompt: string) => Promise<boolean> }) => (
    <button onClick={() => void onAskFix("Fix this exact reply.").catch(() => undefined)}>Ask to fix</button>
  ),
}));
const info: CoordinatorResponse = {
  area: { id: "dev", title: "Development" },
  agent: { requested: "devchief", profile: "devchief", routed: true, reason: "routed" },
  sessionId: "same-session",
  sessionTitle: "Coordinator",
  excluded: false,
  prompt: null,
  lastRunAt: null,
};
let client: QueryClient;
function mount(props: Partial<ComponentProps<typeof CoordinatorThread>> = {}, controlled = false) {
  function Harness() {
    const [draft, setDraft] = useState("Unsent coordinator draft");
    return <CoordinatorThread info={info} {...props} {...(controlled ? { draft, onDraft: setDraft } : {})} />;
  }
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["session", "same-session"], {
    session: { id: "same-session", pinned: false, archived: false },
    timeline: [{ kind: "assistant", id: "rated", text: "Reply to correct" }],
  });
  vi.spyOn(api, "get").mockResolvedValue(client.getQueryData(["session", "same-session"]));
  vi.spyOn(api, "post").mockResolvedValue({ runId: "correction-run" });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it.each([false, true])("correction preserves the coordinator draft and height (controlled=%s)", async (controlled) => {
  mount({ compact: true, context: { label: "Current page", path: "/areas?item=other" } }, controlled);
  const input = screen.getByRole("textbox", { name: "Message the coordinator" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Keep this unsent draft" } });
  input.style.height = "120px";
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/hermes/sessions/same-session/runs", {
      input: "Fix this exact reply.",
      idempotencyKey: expect.stringMatching(/^coord-/),
      capabilities: [SMART_CAPABILITY],
    }),
  );
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(input.value).toBe("Keep this unsent draft");
  expect(input.style.height).toBe("120px");
  expect(screen.getByText("Viewing: Current page")).toBeTruthy();
});

it("regular composer sends still clear the draft", async () => {
  mount();
  const input = screen.getByRole("textbox", { name: "Message the coordinator" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Send this draft" } });
  fireEvent.click(screen.getByTestId("coordinator-send"));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/same-session/runs", expect.objectContaining({ input: "Send this draft" })));
  await waitFor(() => expect(input.value).toBe(""));
});

it("a failed correction keeps the unsent draft", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("Not connected"));
  mount({}, true);
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Unsent coordinator draft");
});

it("an active coordinator run blocks correction sends", () => {
  client.setQueryData(["session", "same-session"], (old: object | undefined) => ({ ...old, session: { id: "same-session", activeRun: { runId: "busy" } } }));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Ask to fix" }));
  expect(api.post).not.toHaveBeenCalled();
});
