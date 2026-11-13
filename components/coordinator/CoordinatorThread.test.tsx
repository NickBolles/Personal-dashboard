// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";
import type { ComposeScope } from "@/lib/coordinator/compose";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { CoordinatorThread, type CoordinatorResponse } from "./CoordinatorThread";
import { COORDINATOR_RUNS_KEY } from "./running/useCoordinatorRuns";

vi.mock("next/navigation", () => ({ usePathname: () => "/areas", useRouter: () => ({ push: vi.fn() }) }));
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

// ---- The one composer: a chip says what the next message is about ------------------------------------------------
const SESSION_RUNS = "/api/hermes/sessions/same-session/runs";
const steerR3: ComposeScope = { kind: "steer", ref: "R-3", title: "Ledger import" };
const field = () => screen.getByRole("textbox", { name: "Message the coordinator" }) as HTMLTextAreaElement;
const sendButton = () => screen.getByTestId("coordinator-send") as HTMLButtonElement;
const chip = () => screen.queryByTestId("gc-scope");
/** The host's side of the composer chip (GlobalCoordinator keeps it; a row in another tab sets it). */
function mountScoped(initial: ComposeScope | null, props: Partial<ComponentProps<typeof CoordinatorThread>> = {}) {
  const seen = vi.fn<(scope: ComposeScope | null) => void>();
  function Harness() {
    const [scope, setScope] = useState<ComposeScope | null>(initial);
    return (
      <>
        <Button onClick={() => setScope(steerR3)}>Steer from a row</Button>
        <CoordinatorThread
          info={info}
          {...props}
          scope={scope}
          onScope={(next) => {
            seen(next);
            setScope(next);
          }}
        />
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return seen;
}
const activeRun = () =>
  client.setQueryData(["session", "same-session"], (old: object | undefined) => ({ ...old, session: { id: "same-session", activeRun: { runId: "busy" } } }));

it("a scope shows as a chip in the composer and changes what the field asks for; setting it sends nothing", () => {
  mountScoped(null);
  expect(chip()).toBeNull();
  expect(field().placeholder).toBe("Ask the coordinator…");
  fireEvent.click(screen.getByRole("button", { name: "Steer from a row" }));
  const group = screen.getByRole("group", { name: "Steering R-3: Ledger import" });
  expect(group).toBe(chip());
  expect(group.getAttribute("data-kind")).toBe("r");
  expect(group.querySelector(".k-ref")!.textContent).toBe("R-3");
  expect(within(group).getByText("Ledger import")).toBeTruthy();
  expect(within(group).getByRole("button", { name: "Remove R-3 from the message" })).toBeTruthy();
  expect(field().placeholder).toBe("Steer R-3…");
  // A steer needs the owner's words: with none there is nothing to send, by button or by shortcut.
  expect(sendButton().disabled).toBe(true);
  fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
  fireEvent.submit(field().closest("form")!);
  expect(api.post).not.toHaveBeenCalled();
});

it.each([
  ["steer", steerR3, "Steer R-3…", "Steer R-3 (Ledger import): Skip the archive tab"],
  ["reply", { kind: "reply", ref: "R-4", title: "Order frames" }, "Reply to R-4…", "Steer R-4 (Order frames): Skip the archive tab"],
  ["steer a sub-agent", { kind: "steer", ref: "R-3", title: "Ledger import", handle: "sa_7" }, "Steer R-3…", "Steer sa_7: Skip the archive tab"],
  ["reply about untracked work", { kind: "reply", title: "Draft the email" }, "Reply to this work…", 'About "Draft the email": Skip the archive tab'],
] as [string, ComposeScope, string, string][])(
  "%s: Send builds the one-line command and sends it through the control channel, then clears the text and the chip",
  async (_name, scope, placeholder, line) => {
    const seen = mountScoped(scope);
    expect(field().placeholder).toBe(placeholder);
    fireEvent.change(field(), { target: { value: "  Skip the\n archive tab " } });
    // Typing sends nothing, and Enter alone is a new line.
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    // No coordinator run in flight: the command starts one, marked as a control message.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledExactlyOnceWith(SESSION_RUNS, {
        input: line,
        idempotencyKey: expect.stringMatching(/^ctl-/),
        capabilities: [SMART_CAPABILITY],
      }),
    );
    await waitFor(() => expect(chip()).toBeNull());
    expect(field().value).toBe("");
    expect(seen).toHaveBeenCalledExactlyOnceWith(null);
    expect(field().placeholder).toBe("Ask the coordinator…");
  },
);

it("while the coordinator has a run in flight a steer goes into that run, not a new one", async () => {
  activeRun();
  mountScoped(steerR3);
  fireEvent.change(field(), { target: { value: "Skip the archive tab" } });
  fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/hermes/runs/busy/steer", { input: "Steer R-3 (Ledger import): Skip the archive tab" }),
  );
  await waitFor(() => expect(chip()).toBeNull());
  expect(field().value).toBe("");
});

it.each([
  ["Retry", "", "Retry R-2 (Ledger import)."],
  ["Resume", "", "Resume R-2 (Ledger import)."],
  ["Retry", " with the  new token ", "Retry R-2 (Ledger import). with the new token"],
] as const)("%s can be sent with no text, or with a note (%j)", async (verb, note, line) => {
  mountScoped({ kind: "retry", ref: "R-2", title: "Ledger import", verb });
  expect(chip()!.querySelector(".k-ref")!.textContent).toBe(`${verb} R-2`);
  expect(screen.getByRole("group", { name: `${verb} R-2: Ledger import` })).toBeTruthy();
  expect(field().placeholder).toBe("Add a note, or just send");
  // The chip alone is not a send: it waits for Send.
  expect(api.post).not.toHaveBeenCalled();
  expect(sendButton().disabled).toBe(false);
  if (note) fireEvent.change(field(), { target: { value: note } });
  fireEvent.click(sendButton());
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith(SESSION_RUNS, expect.objectContaining({ input: line, idempotencyKey: expect.stringMatching(/^ctl-/) })),
  );
  await waitFor(() => expect(chip()).toBeNull());
});

it("a question about a run is an ordinary message, even while a run is in flight", async () => {
  activeRun();
  mountScoped({ kind: "ask", ref: "R-2", title: "Ledger import" });
  expect(field().placeholder).toBe("Ask about R-2…");
  expect(sendButton().disabled).toBe(true);
  fireEvent.change(field(), { target: { value: "Why did it fail?" } });
  fireEvent.click(sendButton());
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith(SESSION_RUNS, {
      input: "About R-2 (Ledger import): Why did it fail?",
      idempotencyKey: expect.stringMatching(/^coord-/),
      capabilities: [SMART_CAPABILITY],
    }),
  );
  await waitFor(() => expect(chip()).toBeNull());
  expect(field().value).toBe("");
});

it("a decision's chip is marked as a decision and asks for an answer in the owner's words; the page rides along in the rail", async () => {
  mountScoped({ kind: "ask", ref: "D-9", title: "Which frame should I order?" }, { compact: true, context: { label: "Areas", path: "/areas" } });
  expect(screen.getByRole("group", { name: "About D-9: Which frame should I order?" }).getAttribute("data-kind")).toBe("d");
  const input = screen.getByTestId("gc-input") as HTMLTextAreaElement;
  expect(input.placeholder).toBe("Answer D-9 in your own words…");
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "The oak one" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      SESSION_RUNS,
      expect.objectContaining({ input: "[Viewing: Areas — /areas]\nAbout D-9 (Which frame should I order?): The oak one" }),
    ),
  );
});

it("with no conversation yet a steer is the first ordinary message of a new one (there is no control channel to use)", async () => {
  vi.mocked(api.post).mockImplementation(async (path: string) => (path === "/api/hermes/sessions" ? { id: "fresh" } : { runId: "r" }));
  const seen = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CoordinatorThread info={{ ...info, sessionId: null }} scope={steerR3} onScope={seen} />
    </QueryClientProvider>,
  );
  fireEvent.change(field(), { target: { value: "Skip the archive tab" } });
  fireEvent.click(sendButton());
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/api/hermes/sessions/fresh/runs",
      expect.objectContaining({ input: "Steer R-3 (Ledger import): Skip the archive tab", idempotencyKey: expect.stringMatching(/^coord-/) }),
    ),
  );
  expect(vi.mocked(api.post).mock.calls.filter(([path]) => String(path).endsWith("/runs"))).toHaveLength(1);
  await waitFor(() => expect(seen).toHaveBeenCalledWith(null));
});

it("Backspace in the empty field removes the chip; with text in the field it only edits the text", () => {
  const seen = mountScoped(steerR3);
  fireEvent.change(field(), { target: { value: "Skip" } });
  fireEvent.keyDown(field(), { key: "Backspace" });
  expect(chip()).toBeTruthy();
  expect(seen).not.toHaveBeenCalled();
  fireEvent.change(field(), { target: { value: "" } });
  // The key is used up by removing the chip.
  expect(fireEvent.keyDown(field(), { key: "Backspace" })).toBe(false);
  expect(chip()).toBeNull();
  expect(seen).toHaveBeenCalledExactlyOnceWith(null);
  expect(field().placeholder).toBe("Ask the coordinator…");
  // With no chip, Backspace is just Backspace.
  expect(fireEvent.keyDown(field(), { key: "Backspace" })).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it("the chip's remove button clears it and keeps what was typed, which then goes as an ordinary message", async () => {
  mountScoped(steerR3);
  fireEvent.change(field(), { target: { value: "Actually, what is left to do?" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove R-3 from the message" }));
  expect(chip()).toBeNull();
  expect(field().value).toBe("Actually, what is left to do?");
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(sendButton());
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      SESSION_RUNS,
      expect.objectContaining({ input: "Actually, what is left to do?", idempotencyKey: expect.stringMatching(/^coord-/) }),
    ),
  );
});

it("a command that could not be sent keeps the text and the chip", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("Not connected"));
  const seen = mountScoped(steerR3);
  fireEvent.change(field(), { target: { value: "Skip the archive tab" } });
  fireEvent.click(sendButton());
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(chip()).toBeTruthy();
  expect(field().value).toBe("Skip the archive tab");
  expect(seen).not.toHaveBeenCalled();
});

it("offline, a chip sends nothing", () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  mountScoped({ kind: "retry", ref: "R-2", title: "Ledger import", verb: "Retry" });
  expect(sendButton().disabled).toBe(true);
  fireEvent.submit(field().closest("form")!);
  fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
  expect(api.post).not.toHaveBeenCalled();
  expect(chip()).toBeTruthy();
});

// ---- References in the text (D-n / R-n) and the rows for what a reply mentions ------------------------------------
const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
type Message = { kind: "user" | "assistant"; id: string; text: string; at?: string };
const thread = (messages: Message[]) =>
  client.setQueryData(["session", "same-session"], { session: { id: "same-session", pinned: false, archived: false }, timeline: messages });
const inlineChips = () => Array.from(document.querySelectorAll<HTMLElement>(".gc-inline-ref")).map((el) => el.textContent);
/** A host that can draw a row for some references: rank decides which and in what order, render draws it. */
function mentionsOf(ranks: Record<string, number | null>) {
  const rank = vi.fn((ref: string) => ranks[ref] ?? null);
  const render = vi.fn((ref: string) => (
    <div data-testid="mention-row" data-ref-row={ref}>
      <a className="k-thing-title" href={`#${ref}`}>
        Row for {ref}
      </a>
    </div>
  ));
  return { rank, render };
}
const mentionSection = (messageText: RegExp) => within(screen.getByText(messageText).closest("li")!).queryByRole("region", { name: "Mentioned in this reply" });
const rowsIn = (section: HTMLElement | null) =>
  section
    ? within(section)
        .getAllByTestId("mention-row")
        .map((el) => el.getAttribute("data-ref-row"))
    : [];

it("a D-n / R-n in a reply or in the owner's own message is a chip that opens the thing; in code or a link label it stays text", () => {
  thread([
    { kind: "user", id: "u1", text: "What about R-5 and D-2?", at: minutesAgo(20) },
    {
      kind: "assistant",
      id: "a1",
      text: "Review **D-48** and R-65. Not `D-99`, not [R-77 notes](https://example.com/notes). PR-7 and R-7b are something else.",
      at: minutesAgo(19),
    },
  ]);
  const onRef = vi.fn();
  mount({ onRef });
  expect(inlineChips()).toEqual(["R-5", "D-2", "D-48", "R-65"]);
  // each is a real button with a spoken name, in the colour of its kind
  const run = screen.getByRole("button", { name: "Run R 65" });
  const decision = screen.getByRole("button", { name: "Decision D 48" });
  expect(run.className).toContain("gc-inline-ref");
  expect(run.getAttribute("data-kind")).toBe("r");
  expect(decision.getAttribute("data-kind")).toBe("d");
  // the reply still reads as written around them
  expect(decision.closest("strong")?.textContent).toBe("D-48");
  expect(screen.getByText("D-99").tagName).toBe("CODE");
  expect(screen.getByRole("link", { name: /R-77 notes/ }).querySelector("button")).toBeNull();
  for (const name of ["Decision D 99", "Run R 77", "Run R 7"]) expect(screen.queryByRole("button", { name })).toBeNull();
  // none of them has a row on screen here, so each opens its tab through the host
  fireEvent.click(run);
  fireEvent.click(decision);
  fireEvent.click(screen.getByRole("button", { name: "Run R 5" }));
  fireEvent.click(screen.getByRole("button", { name: "Decision D 2" }));
  expect(onRef.mock.calls).toEqual([["R-65"], ["D-48"], ["R-5"], ["D-2"]]);
  // the separate "Mentions:" list is gone: the chips are in the text
  expect(screen.queryByText("Mentions:")).toBeNull();
  expect(screen.queryByLabelText("Mentions")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it("with nowhere to open a reference, the text is left exactly as written", () => {
  thread([
    { kind: "user", id: "u1", text: "What about R-5?", at: minutesAgo(20) },
    { kind: "assistant", id: "a1", text: "Review **D-48** and R-65.", at: minutesAgo(19) },
  ]);
  mount();
  expect(inlineChips()).toEqual([]);
  expect(screen.getByText("What about R-5?")).toBeTruthy();
  expect(screen.getByText(/and R-65\.$/).textContent).toBe("Review D-48 and R-65.");
});

it("what a reply mentions is drawn as rows under it, in rank order; a reference with no rank is not drawn", () => {
  thread([{ kind: "assistant", id: "a1", text: "R-4 is slow, R-9 is unknown to me, D-2 waits on you and R-1 failed. `R-3` is only code.", at: minutesAgo(5) }]);
  const mentions = mentionsOf({ "D-2": -1, "R-1": 1, "R-4": 3, "R-3": 0 });
  mount({ mentions, onRef: vi.fn() });
  // lowest rank first (the host ranks what needs the owner first), whatever order the reply names them in
  expect(rowsIn(mentionSection(/is only code\.$/))).toEqual(["D-2", "R-1", "R-4"]);
  expect(screen.getByText("Row for D-2")).toBeTruthy();
  // not drawable (null) and not prose (code): no row, and the host is never asked to draw them
  expect(mentions.render.mock.calls.map(([ref]) => ref)).not.toContain("R-9");
  expect(mentions.render.mock.calls.map(([ref]) => ref)).not.toContain("R-3");
  // three or fewer: nothing folded
  expect(within(mentionSection(/is only code\.$/)!).queryByRole("button", { name: /more|fewer/ })).toBeNull();
  // the references are still chips in the text (R-9 too: it can be opened even though it has no row here)
  expect(inlineChips()).toEqual(["R-4", "R-9", "D-2", "R-1"]);
});

it("a reply with nothing drawable has no section, and without the host's rows there are none at all", () => {
  thread([{ kind: "assistant", id: "a1", text: "R-9 is unknown and nothing else is going on.", at: minutesAgo(5) }]);
  const view = mount({ mentions: mentionsOf({}), onRef: vi.fn() });
  expect(screen.queryByRole("region", { name: "Mentioned in this reply" })).toBeNull();
  view.unmount();
  thread([{ kind: "assistant", id: "a1", text: "D-2 waits on you.", at: minutesAgo(5) }]);
  mount({ onRef: vi.fn() });
  expect(screen.queryByRole("region", { name: "Mentioned in this reply" })).toBeNull();
  expect(inlineChips()).toEqual(["D-2"]);
});

it("a reference is drawn once, under the latest reply that mentions it; the owner's own messages draw no rows", () => {
  thread([
    { kind: "assistant", id: "a1", text: "First: R-1 started and D-2 needs you. R-3 is next.", at: minutesAgo(50) },
    { kind: "user", id: "u1", text: "Tell me about R-1 and R-6", at: minutesAgo(45) },
    { kind: "assistant", id: "a2", text: "Second: R-1 is half way.", at: minutesAgo(40) },
    { kind: "assistant", id: "a3", text: "Third: nothing new.", at: minutesAgo(30) },
  ]);
  mount({ mentions: mentionsOf({ "R-1": 2, "D-2": -1, "R-3": 3, "R-6": 1 }), onRef: vi.fn() });
  // R-1 moved down to the newer reply; the older one keeps what only it mentions
  expect(rowsIn(mentionSection(/^First:/))).toEqual(["D-2", "R-3"]);
  expect(rowsIn(mentionSection(/^Second:/))).toEqual(["R-1"]);
  expect(mentionSection(/^Third:/)).toBeNull();
  expect(screen.getAllByTestId("mention-row")).toHaveLength(3);
  // R-6 is only in the owner's message: a chip there, no row anywhere
  expect(document.querySelector('[data-ref-row="R-6"]')).toBeNull();
  expect(within(screen.getByText(/^Tell me about/).closest("li")!).queryByRole("region")).toBeNull();
  expect(inlineChips()).toContain("R-6");
});

it("at most three rows are drawn under a reply; the rest are named on one line that opens them", () => {
  thread([{ kind: "assistant", id: "a1", text: "R-3, R-4, R-5, D-6, R-8 and R-9 all moved.", at: minutesAgo(5) }]);
  mount({ mentions: mentionsOf({ "D-6": -1, "R-5": 1, "R-3": 2, "R-8": 4, "R-4": 5, "R-9": null }), onRef: vi.fn() });
  const section = mentionSection(/all moved\.$/)!;
  expect(rowsIn(section)).toEqual(["D-6", "R-5", "R-3"]);
  const more = within(section).getByRole("button", { expanded: false });
  // the fold counts and names what is in it, in the same order
  expect(more.textContent).toBe("2 moreR-8R-4");
  expect(Array.from(more.querySelectorAll(".k-ref")).map((el) => [el.textContent, el.getAttribute("data-kind")])).toEqual([
    ["R-8", "r"],
    ["R-4", "r"],
  ]);
  fireEvent.click(more);
  expect(rowsIn(section)).toEqual(["D-6", "R-5", "R-3", "R-8", "R-4"]);
  const fewer = within(section).getByRole("button", { name: "Show fewer", expanded: true });
  fireEvent.click(fewer);
  expect(rowsIn(section)).toEqual(["D-6", "R-5", "R-3"]);
  expect(within(section).getByRole("button", { expanded: false }).textContent).toContain("2 more");
});

/** A reply that started tracked work: sub-agent sa_1, registered as run R-7. */
function startedWork() {
  const started = minutesAgo(59);
  client.setQueryData(["session-exec", "same-session"], {
    sessionId: "same-session",
    parent: null,
    sources: [],
    records: [
      {
        key: "subagent:sa_1",
        source: "subagent",
        id: "sa_1",
        subagentId: "sa_1",
        delegationId: "del_1",
        title: "Audit the feeds",
        state: "running",
        step: "Reading the feeds",
        startedAt: started,
        href: "/chat/child",
      },
      {
        key: "registered_run:run-7",
        source: "registered_run",
        id: "run-7",
        delegationId: "del_1:sa_1",
        title: "Audit the feeds",
        state: "running",
        startedAt: started,
      },
    ],
  });
  client.setQueryData(COORDINATOR_RUNS_KEY, {
    events: [],
    lastLooked: { chat: null, needs: null, running: null, changes: null, context: null },
    runs: [
      {
        id: "run-7",
        ref: "R-7",
        seq: 7,
        itemId: "item",
        itemTitle: "Item",
        profile: "devchief",
        title: "Audit the feeds",
        state: "running",
        stalled: false,
        summary: null,
        prUrl: null,
        parentRunId: null,
        parentRef: null,
        pipeline: [],
        lock: null,
        interruptedAt: null,
        startedAt: started,
        updatedAt: minutesAgo(2),
        finishedAt: null,
        noticeCount: 0,
      },
    ],
  });
  thread([
    { kind: "assistant", id: "a1", text: "Started R-7 for the feeds.", at: minutesAgo(58) },
    { kind: "user", id: "u1", text: "How is R-7 doing, and D-2?", at: minutesAgo(12) },
    { kind: "assistant", id: "a2", text: "R-7 is half way; R-8 is queued behind it and D-2 still waits. R-99 I cannot find.", at: minutesAgo(10) },
  ]);
}

it("work that already has its row under the reply that started it is not drawn again as a mention, under any reply", async () => {
  startedWork();
  const mentions = mentionsOf({ "R-7": 0, "R-8": 3, "D-2": -1 });
  mount({ mentions, onRef: vi.fn() });
  const work = await screen.findByTestId("coordinator-run-card");
  await waitFor(() => expect(work.getAttribute("data-run-ref")).toBe("R-7"));
  // (the messages and the work load separately: until both are in, the row waits after the last message)
  await waitFor(() =>
    expect(
      within(screen.getByText(/^Started/).closest("li")!)
        .getByRole("region", { name: "Work started by this reply" })
        .contains(work),
    ).toBe(true),
  );
  // the later reply mentions R-7 too, and the host could draw it: it has its row already, so it is not drawn twice
  expect(mentionSection(/^Started/)).toBeNull();
  expect(rowsIn(mentionSection(/is half way/))).toEqual(["D-2", "R-8"]);
  // (What is on screen is what matters: until the tracked runs have loaded the work has no R-n yet, so the host
  // may be asked for R-7 once before the row claims it.)
  expect(document.querySelectorAll('[data-run-ref="R-7"], [data-ref-row="R-7"]')).toHaveLength(1);
});

it("a chip in the text jumps to the thing's row when it is on screen in the thread, and only otherwise leaves the conversation", async () => {
  startedWork();
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const onRef = vi.fn();
  try {
    mount({ mentions: mentionsOf({ "R-8": 3, "D-2": -1 }), onRef });
    const work = await screen.findByTestId("coordinator-run-card");
    await waitFor(() => expect(work.getAttribute("data-run-ref")).toBe("R-7"));
    const chipsFor = (name: string) => screen.getAllByRole("button", { name }).filter((el) => el.classList.contains("gc-inline-ref"));
    // R-7 is written three times (two replies and the owner's question): every chip lands on its one row
    expect(chipsFor("Run R 7")).toHaveLength(3);
    for (const [index, chip] of chipsFor("Run R 7").entries()) {
      work.removeAttribute("data-landed");
      fireEvent.click(chip);
      expect(work.hasAttribute("data-landed")).toBe(true);
      expect(scrolled).toHaveBeenCalledTimes(index + 1);
      expect(scrolled.mock.contexts.at(-1)).toBe(work);
      expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
    }
    // and hands the keyboard to the row (its title, which opens the work itself)
    expect(document.activeElement).toBe(work.querySelector(".k-thing-title"));
    expect((document.activeElement as HTMLAnchorElement).getAttribute("href")).toBe("/chat/child");
    // a mentioned decision's row is on screen too
    const decision = document.querySelector<HTMLElement>('[data-ref-row="D-2"]')!;
    for (const chip of chipsFor("Decision D 2")) fireEvent.click(chip);
    expect(decision.hasAttribute("data-landed")).toBe(true);
    expect(document.activeElement).toBe(decision.querySelector(".k-thing-title"));
    // staying in the conversation is not opening a tab
    expect(onRef).not.toHaveBeenCalled();
    // nothing on screen for R-99: that one goes to its tab
    fireEvent.click(chipsFor("Run R 99")[0]!);
    expect(onRef).toHaveBeenCalledExactlyOnceWith("R-99");
    expect(document.querySelectorAll("[data-landed]")).toHaveLength(2);
    // the mark is momentary
    await waitFor(() => expect(document.querySelectorAll("[data-landed]")).toHaveLength(0), { timeout: 3000 });
    expect(api.post).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

// ---- answering a decision in your own words -------------------------------------------------------------------

const answerD5: ComposeScope = { kind: "answer", ref: "D-5", title: "Which day works for the furnace visit?" };

it("a decision's chip records what is typed as its answer: nothing goes to the conversation", async () => {
  const onAnswer = vi.fn(async () => true);
  mountScoped(answerD5, { onAnswer });
  expect(chip()?.getAttribute("aria-label")).toBe("Answering D-5: Which day works for the furnace visit?");
  expect(field().placeholder).toBe("Answer D-5 in your own words…");
  // nothing to record yet
  fireEvent.click(sendButton());
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.change(field(), { target: { value: "  Thursday before noon  " } });
  fireEvent.click(sendButton());
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith(answerD5, "Thursday before noon", false);
  await waitFor(() => expect(chip()).toBeNull());
  expect(field().value).toBe("");
  expect(api.post).not.toHaveBeenCalled();
});

it("an answer that could not be recorded keeps the words and the chip", async () => {
  const onAnswer = vi.fn(async () => false);
  mountScoped(answerD5, { onAnswer });
  fireEvent.change(field(), { target: { value: "Thursday" } });
  fireEvent.click(sendButton());
  await waitFor(() => expect(onAnswer).toHaveBeenCalledOnce());
  expect(chip()).toBeTruthy();
  expect(field().value).toBe("Thursday");
});

it("a risky decision's typed answer takes a second send, for exactly those words", async () => {
  const onAnswer = vi.fn(async () => true);
  const risky: ComposeScope = { ...answerD5, risky: true };
  mountScoped(risky, { onAnswer });
  fireEvent.change(field(), { target: { value: "Pay the deposit" } });
  fireEvent.click(sendButton());
  // the first send only arms it
  expect(onAnswer).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("D-5 is flagged risky");
  // changing the words disarms: the confirmation was for the other answer
  fireEvent.change(field(), { target: { value: "Pay the deposit tomorrow" } });
  expect(screen.queryByText(/is flagged risky/)).toBeNull();
  fireEvent.click(sendButton());
  expect(onAnswer).not.toHaveBeenCalled();
  // Cancel disarms too
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/is flagged risky/)).toBeNull();
  fireEvent.click(sendButton());
  expect(onAnswer).not.toHaveBeenCalled();
  // the second send, with the same words, records it as confirmed
  fireEvent.click(sendButton());
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith(risky, "Pay the deposit tomorrow", true);
  await waitFor(() => expect(chip()).toBeNull());
  expect(api.post).not.toHaveBeenCalled();
});
