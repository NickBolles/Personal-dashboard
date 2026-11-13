// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import type { DecisionEntry, DecisionsResponse } from "@/lib/decisions";
import { ToastProvider } from "@/components/ui";
import { DecisionsList, orderEntries } from "@/components/map/Decisions";
import { DecisionDetail } from "./DecisionDetail";
import { ItemDecisions } from "./DecisionBlock";
import { ConfirmNeededError, DECISIONS_KEY, INBOX_KEY, useAnswerDecision } from "./useAnswerDecision";

vi.mock("@/lib/client/api", () => {
  class ApiError extends Error {
    status = 500;
  }
  return { api: { get: vi.fn(), post: vi.fn() }, ApiError };
});

const clock = Date.parse("2026-11-08T12:00:00Z");
const entry = (seq: number, extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
  key: `item:wk_${seq}`,
  kind: "item",
  itemId: `wk_${seq}`,
  title: `Item ${seq}`,
  question: `Question ${seq}?`,
  choices: ["Cedar", "Spruce"],
  href: `/areas?item=wk_${seq}`,
  at: new Date(clock - 3_600_000).toISOString(),
  areaTitle: "Workshop",
  ref: `D-${seq}`,
  decisionId: `dec_${seq}`,
  recommended: null,
  risk: [],
  pack: {},
  defaultChoice: null,
  expiresAt: null,
  runId: null,
  ...extra,
});
const approval: DecisionEntry = {
  key: "approval:run_1",
  kind: "approval",
  title: "Hermes needs your approval",
  question: "Recursive delete",
  choices: [],
  href: "/chat/sess_1",
  at: new Date(clock - 60_000).toISOString(),
};
const stalled: DecisionEntry = {
  key: "stalled:arun_1",
  kind: "stalled",
  title: "Checkout refactor",
  question: "@devchief's run \"Smoke tests\" hasn't reported in over 30 min. Check on it; nothing was changed.",
  choices: [],
  href: "/areas?item=wk_checkout",
  at: new Date(clock - 2_400_000).toISOString(),
  itemId: "wk_checkout",
  runRef: "R-3",
};

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
const answerCalls = () => vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith("/answer"));
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(clock);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path.endsWith("/answer")) return { decision: {}, op: { id: `op-${path.match(/D-\d+/)![0]}`, kind: "edit", label: "Saved" } };
    if (path.endsWith("/undo")) return { itemId: "x", item: null, outcome: "undone" };
    if (path.endsWith("/runs")) return { ok: true };
    throw new Error(`Unexpected API path ${path}`);
  });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the one answer hook", () => {
  it("never posts a risky answer without the second, explicit tap", async () => {
    const { result } = renderHook(() => useAnswerDecision(), { wrapper });
    await expect(result.current.mutateAsync({ decision: { ref: "D-9", risk: ["money"] }, answer: "Pay it" })).rejects.toBeInstanceOf(ConfirmNeededError);
    // Free text is held to the same rule as a listed choice.
    await expect(result.current.mutateAsync({ decision: { ref: "D-9", risk: ["destructive"] }, answer: "just delete it all" })).rejects.toBeInstanceOf(
      ConfirmNeededError,
    );
    expect(api.post).not.toHaveBeenCalled();
    await result.current.mutateAsync({ decision: { ref: "D-9", risk: ["money"] }, answer: "Pay it", confirmed: true });
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/coordinator/decisions/D-9/answer", {
      answer: "Pay it",
      via: "queue",
      idempotencyKey: expect.any(String),
    });
  });
  it("refuses an empty answer", async () => {
    const { result } = renderHook(() => useAnswerDecision(), { wrapper });
    await expect(result.current.mutateAsync({ decision: { ref: "D-9", risk: [] }, answer: "   " })).rejects.toThrow("Answer is empty");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("takes the decision out of the queue and the inbox at once, and puts it back when the write fails", async () => {
    const inbox: DecisionsResponse = { entries: [entry(5), entry(6), approval], count: 3 };
    const queue = { decisions: [{ ref: "D-5" }, { ref: "D-6" }], counts: { open: 2, deferred: 0 } };
    qc.setQueryData(INBOX_KEY, inbox);
    qc.setQueryData(DECISIONS_KEY, queue);
    let fail!: (e: Error) => void;
    vi.mocked(api.post).mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const { result } = renderHook(() => useAnswerDecision(), { wrapper });
    const sent = result.current.mutateAsync({ decision: { ref: "D-5", risk: [] }, answer: "Cedar" }).catch((e: Error) => e);
    await waitFor(() => expect(qc.getQueryData<DecisionsResponse>(INBOX_KEY)?.count).toBe(2));
    expect(qc.getQueryData<DecisionsResponse>(INBOX_KEY)?.entries.map((e) => e.key)).toEqual(["item:wk_6", "approval:run_1"]);
    expect(qc.getQueryData<typeof queue>(DECISIONS_KEY)).toEqual({ decisions: [{ ref: "D-6" }], counts: { open: 1, deferred: 0 } });
    fail(new Error("Offline"));
    expect(((await sent) as Error).message).toBe("Offline");
    expect(qc.getQueryData(INBOX_KEY)).toEqual(inbox);
    expect(qc.getQueryData(DECISIONS_KEY)).toEqual(queue);
  });
});

describe("the Needs you list (/decisions, Today, Map, Portfolio)", () => {
  it("a risky decision cannot be answered by one tap: no chips, the card arms, only Confirm sends", async () => {
    render(<DecisionsList entries={[entry(7, { risk: ["destructive"], recommended: "Cedar" })]} />, { wrapper });
    const row = screen.getByTestId("decision-row");
    // The list used to draw a chip per choice here and send on the first tap.
    expect(within(row).queryByRole("button", { name: /Cedar/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Spruce/ })).toBeNull();
    expect(row.textContent).toContain("Destructive");
    fireEvent.click(within(row).getByRole("button", { name: /^Open decision D-7/ }));
    const card = screen.getByTestId("decision-card");
    fireEvent.click(within(card).getByRole("button", { name: /^Cedar/ }));
    expect(api.post).not.toHaveBeenCalled();
    const confirm = within(card).getByRole("group", { name: "Confirm answer" });
    // Changing one's mind costs nothing.
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group", { name: "Confirm answer" })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: /^Spruce/ }));
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(within(within(card).getByRole("group", { name: "Confirm answer" })).getByRole("button", { name: "Confirm: Spruce" }));
    await waitFor(() => expect(answerCalls()).toHaveLength(1));
    expect(answerCalls()[0]).toEqual(["/api/coordinator/decisions/D-7/answer", { answer: "Spruce", via: "queue", idempotencyKey: expect.any(String) }]);
  });
  it("number keys arm a risky choice too; they never send it", () => {
    render(<DecisionsList entries={[entry(7, { risk: ["money"] })]} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /^Open decision D-7/ }));
    const host = screen.getByTestId("decision-card").parentElement!;
    fireEvent.keyDown(host, { key: "1" });
    expect(screen.getByRole("group", { name: "Confirm answer" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("a low-risk decision answers in one tap through the one path, and leaves a receipt with Undo", async () => {
    render(<DecisionsList entries={[entry(8, { recommended: "Spruce" })]} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "D-8: Spruce (recommended)" }));
    const receipt = await screen.findByTestId("decision-receipt");
    expect(receipt.getAttribute("title")).toBe("D-8 · Question 8? · Spruce");
    // One path for every surface: never the old per-item route.
    expect(answerCalls()).toEqual([["/api/coordinator/decisions/D-8/answer", { answer: "Spruce", via: "queue", idempotencyKey: expect.any(String) }]]);
    expect(screen.queryByText("Answered")).toBeNull();
    fireEvent.click(within(receipt).getByRole("button", { name: "Undo D-8" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/work/ops/op-D-8/undo"));
    await screen.findByRole("button", { name: "D-8: Spruce (recommended)" });
  });
  it("has no text box: a decision without listed answers goes to the composer", () => {
    const onAsk = vi.fn();
    render(<DecisionsList entries={[entry(9, { choices: [] }), entry(10)]} onAsk={onAsk} />, { wrapper });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText("Short answer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open decision D-9/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer in your own words: D-9" }));
    expect(onAsk).toHaveBeenCalledWith("D-9", "Question 9?");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("with no composer on the page, Something else opens the Chief of staff on that decision and keeps the page's parameters", () => {
    window.history.replaceState(null, "", "/areas?item=wk_10");
    render(<DecisionsList entries={[entry(10)]} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /^Open decision D-10/ }));
    fireEvent.click(screen.getByRole("button", { name: "Something else: D-10" }));
    expect(window.location.pathname).toBe("/areas");
    expect(new URLSearchParams(window.location.search).get("item")).toBe("wk_10");
    expect(new URLSearchParams(window.location.search).get("coord")).toBe("needs");
    expect(new URLSearchParams(window.location.search).get("d")).toBe("D-10");
    expect(api.post).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
  });
  it("offers to post the answer to the conversation as a quiet action on the receipt; Undo withdraws it (#167)", async () => {
    render(<DecisionsList entries={[entry(11, { coordinatorSessionId: "sess_coord" })]} />, { wrapper });
    // Nothing is offered, and nothing is posted, before there is an answer.
    expect(screen.queryByTestId("decision-post")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "D-11: Cedar" }));
    const receipt = await screen.findByTestId("decision-receipt");
    const post = within(receipt).getByRole("button", { name: "Post to coordinator" });
    expect(vi.mocked(api.post).mock.calls.some(([path]) => path.endsWith("/runs"))).toBe(false);
    fireEvent.click(within(receipt).getByRole("button", { name: "Undo D-11" }));
    await screen.findByRole("button", { name: "D-11: Cedar" });
    expect(post.isConnected).toBe(false);
    expect(vi.mocked(api.post).mock.calls.some(([path]) => path.endsWith("/runs"))).toBe(false);
    // Answer again and take the offer: one explicit tap posts the same line the chat reads as a decision.
    fireEvent.click(screen.getByRole("button", { name: "D-11: Cedar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Post to coordinator" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/hermes/sessions/sess_coord/runs", {
        input: 'Decision on "Item 11": Decision: Question 11? → Cedar',
        idempotencyKey: expect.any(String),
      }),
    );
  });
  it("a receipt leaves the list when Undo expires, unless it still offers to post the answer", async () => {
    vi.useFakeTimers();
    render(<DecisionsList entries={[entry(12), entry(13, { sessionId: "sess_item" })]} />, { wrapper });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "D-12: Cedar" }));
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "D-13: Cedar" }));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getAllByTestId("decision-receipt")).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const left = screen.getAllByTestId("decision-receipt");
    expect(left.map((el) => el.getAttribute("data-ref"))).toEqual(["D-13"]);
    // Undo is over; the quiet follow-up is still there.
    expect(within(left[0]).queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(within(left[0]).getByRole("button", { name: "Post to conversation" })).toBeTruthy();
  });
  it("draws approvals, proposals and stalled runs as rows of the same shape that say where they open", () => {
    const workflow: DecisionEntry = {
      ...approval,
      key: "workflow:wf_1",
      kind: "workflow",
      title: "Weekly plan",
      question: "2 proposed values to accept or dismiss",
      href: "/workflows",
    };
    render(<DecisionsList entries={[stalled, approval, workflow, entry(14)]} />, { wrapper });
    const rows = screen.getAllByTestId("decision-row");
    // One list, one order: the decision, then what waits on a tap elsewhere, then the run that went silent.
    expect(rows.map((row) => row.getAttribute("data-kind") ?? row.getAttribute("data-ref"))).toEqual(["D-14", "approval", "workflow", "stalled"]);
    const [, approvalRow, workflowRow, stalledRow] = rows;
    expect(within(approvalRow).getByRole("link").getAttribute("href")).toBe("/chat/sess_1");
    expect(approvalRow.textContent).toContain("Recursive delete");
    expect(approvalRow.textContent).toContain("opens the conversation");
    // Truthful about the destination: this proposal has no conversation, it opens Workflows.
    expect(workflowRow.textContent).toContain("opens Workflows");
    expect(within(stalledRow).getByLabelText("Run R 3")).toBeTruthy();
    expect(stalledRow.querySelector(".k-sw")?.textContent).toBe("Stalled");
    expect(stalledRow.getAttribute("data-state")).toBe("stalled");
    expect(stalledRow.textContent).toContain("opens the item");
    // None of them can be answered from here.
    expect(within(approvalRow).queryByRole("button")).toBeNull();
    expect(within(stalledRow).queryByRole("button")).toBeNull();
  });
  it("orders decisions as the Chief of staff queue does: waiting over a day, then risky, then the rest", () => {
    const old = entry(1, { at: new Date(clock - 3 * 86_400_000).toISOString() });
    const risky = entry(3, { risk: ["money"] });
    const plain = entry(2);
    const ordered = orderEntries([plain, approval, risky, stalled, old], new Date(clock));
    expect(ordered.decisions.map((d) => d.ref)).toEqual(["D-1", "D-3", "D-2"]);
    expect(ordered.waiting.map((e) => e.key)).toEqual(["approval:run_1"]);
    expect(ordered.stalled.map((e) => e.key)).toEqual(["stalled:arun_1"]);
  });
  it("the open card pages through the list's decisions", () => {
    render(<DecisionsList entries={[entry(15), entry(16), entry(17)]} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /^Open decision D-17/ }));
    expect(screen.getByLabelText("Decision 1 of 3").textContent).toBe("1 of 3");
    expect(screen.getByRole("button", { name: "Previous decision" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Next decision" }));
    expect(screen.getByTestId("decision-card").getAttribute("data-ref")).toBe("D-16");
    // One card at a time: the decision left behind is a row again.
    expect(screen.getByRole("button", { name: /^Open decision D-17/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the list from D-16" }));
    expect(screen.queryByTestId("decision-card")).toBeNull();
  });
  it("says the list is empty once", () => {
    render(<DecisionsList entries={[]} emptyHint="Decisions land here." />, { wrapper });
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
    expect(screen.getByText("Decisions land here.")).toBeTruthy();
  });
});

describe("the decision page (/decisions/<key>)", () => {
  const serve = (e: DecisionEntry | null) =>
    vi.mocked(api.get).mockImplementation(async () => {
      if (!e) throw Object.assign(new Error("gone"), { status: 404 });
      return { entry: e };
    });
  it("a low-risk choice answers in one tap, with no confirm dialog; the page becomes the receipt", async () => {
    serve(entry(20, { recommended: "Cedar" }));
    render(<DecisionDetail id="item:wk_20" />, { wrapper });
    const card = await screen.findByTestId("decision-card");
    // The card is the sheet: its title bar is the page's heading and its way back.
    expect(screen.getByRole("heading", { level: 1, name: "Decision" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Needs you" }).getAttribute("href")).toBe("/decisions");
    expect(within(card).getByRole("button", { name: /^Cedar/ }).textContent).toContain("Recommended");
    fireEvent.click(within(card).getByRole("button", { name: /^Spruce/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(answerCalls()).toHaveLength(1));
    expect(answerCalls()[0][0]).toBe("/api/coordinator/decisions/D-20/answer");
    const receipt = await screen.findByTestId("decision-receipt");
    expect(receipt.getAttribute("title")).toBe("D-20 · Question 20? · Spruce");
    expect(within(receipt).getByRole("button", { name: "Undo D-20" })).toBeTruthy();
    expect(screen.queryByText(/Decision recorded/)).toBeNull();
  });
  it("a deep link that names a choice arms a risky decision and sends nothing; an unknown choice is ignored", async () => {
    serve(entry(21, { risk: ["public"] }));
    const first = render(<DecisionDetail id="item:wk_21" initialChoice="Spruce" />, { wrapper });
    const confirm = await screen.findByRole("group", { name: "Confirm answer" });
    expect(within(confirm).getByRole("button", { name: "Confirm: Spruce" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    first.unmount();
    qc.clear();
    render(<DecisionDetail id="item:wk_21" initialChoice="untrusted option" />, { wrapper });
    await screen.findByTestId("decision-card");
    expect(screen.queryByRole("group", { name: "Confirm answer" })).toBeNull();
    expect(screen.queryByText("untrusted option")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("a deep link that names a choice never answers a low-risk decision by itself", async () => {
    serve(entry(22));
    render(<DecisionDetail id="item:wk_22" initialChoice="Cedar" />, { wrapper });
    await screen.findByTestId("decision-card");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("an approval is not answered here: the page says where it is", async () => {
    serve(approval);
    render(<DecisionDetail id="approval:run_1" />, { wrapper });
    expect(await screen.findByRole("link", { name: "Open conversation to approve or deny" })).toBeTruthy();
    expect(screen.queryByTestId("decision-card")).toBeNull();
    expect(screen.getByText(/Nothing is applied from this page/)).toBeTruthy();
  });
});

describe("an item's open decisions (top of the item page)", () => {
  it("draws nothing for an item with none, and one paged card for an item with several", async () => {
    vi.mocked(api.get).mockResolvedValue({
      entries: [entry(30, { itemId: "wk_a" }), entry(31, { itemId: "wk_a", risk: ["device"] }), entry(32, { itemId: "wk_b" })],
      count: 3,
    });
    const none = render(<ItemDecisions itemId="wk_none" />, { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await act(async () => {});
    expect(none.container.textContent).toBe("");
    none.unmount();
    render(<ItemDecisions itemId="wk_a" />, { wrapper });
    const card = await screen.findByTestId("decision-card");
    expect(card.getAttribute("data-ref")).toBe("D-30");
    expect(screen.getByLabelText("Decision 1 of 2")).toBeTruthy();
    expect(screen.getByText("Moves to D-31 after you answer")).toBeTruthy();
    // Answering the first leaves its receipt and shows the next one, which is risky and waits for Confirm.
    fireEvent.click(within(card).getByRole("button", { name: /^Cedar/ }));
    await waitFor(() => expect(screen.getByTestId("decision-card").getAttribute("data-ref")).toBe("D-31"));
    expect(screen.getByTestId("decision-receipt").getAttribute("title")).toBe("D-30 · Question 30? · Cedar");
    fireEvent.click(within(screen.getByTestId("decision-card")).getByRole("button", { name: /^Cedar/ }));
    expect(screen.getByRole("group", { name: "Confirm answer" })).toBeTruthy();
    expect(answerCalls()).toHaveLength(1);
  });
});
