// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import type { Decision } from "@/lib/cw-decisions";
import { ToastProvider } from "@/components/ui";
import { DecisionDetail } from "./DecisionDetail";
import { NeedsList } from "./NeedsList";
import { NeedsPanel } from "./NeedsPanel";
import { DECISIONS_KEY } from "./useCoordinatorDecisions";

vi.mock("@/lib/client/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const clock = Date.parse("2026-11-08T12:00:00Z");
const decision = (seq = 48, overrides: Partial<Decision> = {}): Decision => ({
  id: `decision-${seq}`,
  ref: `D-${seq}`,
  seq,
  itemId: `item-${seq}`,
  itemTitle: `Item ${seq}`,
  areaTitle: "Development",
  runId: null,
  question: `Question ${seq}?`,
  choices: ["Accept", "Decline"],
  recommended: "Accept",
  risk: [],
  pack: { why: "Unblock the next step", options: [{ choice: "Accept", effect: "Work can continue" }] },
  defaultChoice: null,
  expiresAt: null,
  state: "open",
  answeredChoice: null,
  answeredAt: null,
  answeredVia: null,
  deferredUntil: null,
  supersededBy: null,
  raisedBy: "agent:devchief",
  createdAt: new Date(clock - 7_200_000).toISOString(),
  updatedAt: new Date(clock).toISOString(),
  ...overrides,
});
let rows: Decision[];
let original: Map<string, Decision>;
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
async function ready() {
  await screen.findByText("1 open decision");
}
beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  rows = [decision()];
  original = new Map();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  vi.mocked(api.get).mockImplementation(async () => ({ decisions: [...rows], counts: { open: rows.length, deferred: 0 } }));
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    const ref = path.match(/decisions\/(D-\d+)\//)?.[1];
    if (path.endsWith("/answer") && ref) {
      const d = rows.find((row) => row.ref === ref)!;
      original.set(`op-${ref}`, d);
      rows = rows.filter((row) => row.ref !== ref);
      return {
        decision: { ...d, state: "answered", answeredChoice: (body as { answer: string }).answer },
        op: { id: `op-${ref}`, kind: "edit", label: "Answered" },
      };
    }
    if (path.endsWith("/undo")) {
      const id = path.split("/").at(-2)!;
      const d = original.get(id);
      if (d) rows = [...rows, d];
      return { itemId: d?.itemId, item: null, outcome: "undone" };
    }
    if (path.endsWith("/defer") && ref) {
      const d = rows.find((row) => row.ref === ref)!;
      rows = rows.filter((row) => row.ref !== ref);
      return { decision: { ...d, state: "deferred", deferredUntil: (body as { until: string }).until } };
    }
    throw new Error(`Unexpected API path ${path}`);
  });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Needs you owner actions", () => {
  it("answers a low-risk chip in one tap, invalidates work/activity and offers real Undo", async () => {
    const onAnswered = vi.fn();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    render(<NeedsList decisions={rows} onOpen={vi.fn()} onAnswered={onAnswered} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "D-48: Accept" }));
    await screen.findByText("D-48 → Accept");
    expect(api.post).toHaveBeenCalledWith("/api/coordinator/decisions/D-48/answer", { answer: "Accept", via: "queue", idempotencyKey: expect.any(String) });
    expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ id: "op-D-48" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["work"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activity"] });
    expect(screen.getAllByRole("button", { name: "Undo" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/work/ops/op-D-48/undo"));
    await screen.findByRole("button", { name: "D-48: Accept" });
  });
  it("opens a risky chip with the recommendation armed without answering", () => {
    const onOpen = vi.fn();
    render(<NeedsList decisions={[decision(48, { risk: ["money"] })]} onOpen={onOpen} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "D-48: Accept" }));
    expect(onOpen).toHaveBeenCalledWith("D-48", { arm: "Accept" });
    expect(api.post).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation for risky options and uses the danger variant", async () => {
    rows = [decision(48, { risk: ["money", "credential"] })];
    render(<DecisionDetail decisions={rows} refId="D-48" onBack={vi.fn()} onNavigate={vi.fn()} onAsk={vi.fn()} />, { wrapper });
    fireEvent.click(screen.getByRole("radio", { name: /Accept/ }));
    const confirm = screen.getByRole("group", { name: "Confirm answer" });
    expect(confirm.textContent).toContain("Money · Credential");
    expect(api.post).not.toHaveBeenCalled();
    expect(within(confirm).getByRole("button", { name: "Confirm Accept" }).className).toContain("k-btn-danger");
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm Accept" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });
  it("shows 1 / 3, navigates with next, and resets the armed answer", async () => {
    rows = [decision(48, { risk: ["public"] }), decision(49), decision(50)];
    render(<NeedsPanel onAsk={vi.fn()} initialRef="D-48" />, { wrapper });
    expect(await screen.findByLabelText("Decision 1 of 3")).toHaveProperty("textContent", "1 / 3");
    fireEvent.click(screen.getByRole("radio", { name: /Accept/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next decision" }));
    expect(screen.getByLabelText("Decision 2 of 3").textContent).toBe("2 / 3");
    expect(screen.queryByRole("group", { name: "Confirm answer" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Question 49?" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("auto-advances 600 ms after an answer and retains Undo in the panel", async () => {
    rows = [decision(48), decision(49), decision(50)];
    render(<NeedsPanel onAsk={vi.fn()} initialRef="D-48" />, { wrapper });
    fireEvent.click(await screen.findByRole("radio", { name: /Accept/ }));
    await screen.findByText("D-48 → Accept");
    expect(screen.getByRole("heading", { name: "Question 48?" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Question 49?" })).toBeTruthy(), { timeout: 1800 });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByRole("heading", { name: "Question 48?" });
  });
  it("Undo before auto-advance cancels navigation", async () => {
    const onNavigate = vi.fn();
    render(<DecisionDetail decisions={rows} refId="D-48" onBack={vi.fn()} onNavigate={onNavigate} onAsk={vi.fn()} />, { wrapper });
    fireEvent.click(screen.getByRole("radio", { name: /Accept/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("D-48"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
  it("Ask only calls the owner callback with the decision ref and question", async () => {
    const onAsk = vi.fn();
    render(<NeedsPanel onAsk={onAsk} initialRef="D-48" />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Ask about D-48" }));
    expect(onAsk).toHaveBeenCalledWith("D-48", "Question 48?");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("the list Ask about menu prefills through onAsk, never sends", async () => {
    const onAsk = vi.fn();
    render(<NeedsPanel onAsk={onAsk} />, { wrapper });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "More actions for D-48" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask about" }));
    expect(onAsk).toHaveBeenCalledWith("D-48", "Question 48?");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("shows the specified empty state", () => {
    render(<NeedsList decisions={[]} onOpen={vi.fn()} />, { wrapper });
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByText("New decisions from agents show up here.")).toBeTruthy();
  });
  it("handles a closed deep link without options", () => {
    render(<DecisionDetail decisions={[]} refId="D-48" onBack={vi.fn()} onNavigate={vi.fn()} onAsk={vi.fn()} />, { wrapper });
    expect(screen.getByText("D-48 was already answered")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
  it("confirms a low-risk batch, answers sequentially, and undoes in reverse order", async () => {
    rows = [decision(48), decision(49), decision(50, { risk: ["device"] }), decision(51, { recommended: null })];
    render(<NeedsPanel onAsk={vi.fn()} />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Accept 2 low-risk" }));
    expect(screen.getByText("Accept 2 recommended answers?")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Answered 2");
    expect(
      vi
        .mocked(api.post)
        .mock.calls.slice(0, 2)
        .map(([path]) => path),
    ).toEqual(["/api/coordinator/decisions/D-48/answer", "/api/coordinator/decisions/D-49/answer"]);
    const notice = screen.getByText("Answered 2").closest("[role='status']") as HTMLElement;
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(api.post)
          .mock.calls.slice(2)
          .map(([path]) => path),
      ).toEqual(["/api/work/ops/op-D-49/undo", "/api/work/ops/op-D-48/undo"]),
    );
  });
  it("re-arms the same risky decision after Cancel when its chip is tapped again", async () => {
    rows = [decision(48, { risk: ["public"] })];
    render(<NeedsPanel onAsk={vi.fn()} initialRef="D-48" />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "D-48: Accept" }));
    expect(screen.getByRole("group", { name: "Confirm answer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "D-48: Accept" }));
    expect(screen.getByRole("group", { name: "Confirm answer" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("rechecks the refreshed queue between batch answers and skips a newly risky row", async () => {
    rows = [decision(48), decision(49)];
    const post = vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async (path, body) => {
      const result = await post(path, body);
      if (path === "/api/coordinator/decisions/D-48/answer") rows = rows.map((d) => ({ ...d, risk: ["money"] }));
      return result;
    });
    render(<NeedsPanel onAsk={vi.fn()} />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Accept 2 low-risk" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Answered 1");
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it("shows loading skeletons and the specified retry error", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("Offline"));
    render(<NeedsPanel onAsk={vi.fn()} />, { wrapper });
    expect(screen.getByRole("status", { name: "Loading decisions" })).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Decisions couldn't load.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("lists what has waited over a day first; every row in a large queue keeps its ref and wraps", () => {
    const many = Array.from({ length: 13 }, (_, i) => decision(48 + i, i === 0 ? { createdAt: new Date(clock - 172_800_000).toISOString() } : {}));
    vi.spyOn(Date, "now").mockReturnValue(clock);
    const { container } = render(<NeedsList decisions={many} onOpen={vi.fn()} />, { wrapper });
    expect(screen.getByRole("region", { name: "Waiting over a day" }).textContent).toContain("D-48");
    expect(screen.getByLabelText("Decision D 48")).toBeTruthy();
    expect(screen.getByRole("region", { name: "New" }).querySelectorAll(".gc-needs-row").length).toBe(12);
    // No one-line variant: it dropped the ref and overflowed sideways on phones.
    expect(container.querySelectorAll(".gc-needs-row-title.line-clamp-2").length).toBe(13);
    expect(screen.getByLabelText("Decision D 60")).toBeTruthy();
  });
  it("leads a row with the first sentence of a paragraph-long question and does not repeat the item title", () => {
    const long = decision(70, {
      itemTitle: "Release-clone cleanup",
      question: "@devchief proposes: settle. This item is ready_to_settle; its record reports cleanup completed on 2026-11-02, with no dependents remaining.",
    });
    const echo = decision(71, { itemTitle: "Rotate the storefront DB password", question: "Rotate the storefront DB password?" });
    vi.spyOn(Date, "now").mockReturnValue(clock);
    render(<NeedsList decisions={[long, echo]} onOpen={vi.fn()} />, { wrapper });
    const rowOf = (ref: string) => screen.getByRole("button", { name: new RegExp(`^Open decision ${ref}:`) });
    expect(rowOf("D-70").querySelector(".gc-needs-row-title")?.textContent).toBe("@devchief proposes: settle.");
    expect(rowOf("D-70").textContent).toContain("Development / Release-clone cleanup");
    expect(rowOf("D-71").querySelector(".gc-needs-meta")?.textContent).not.toContain("Rotate the storefront DB password");
    expect(rowOf("D-71").querySelector(".gc-needs-meta")?.textContent).toContain("Development");
    // One-tap answers only where the whole question is on the row; otherwise the answer waits for the detail.
    expect(screen.queryByRole("button", { name: "D-70: Accept" })).toBeNull();
    expect(screen.getByRole("button", { name: "D-71: Accept" })).toBeTruthy();
  });
  it("the detail shows a short heading, the rest as body text, and plain status words", () => {
    rows = [
      decision(70, {
        question: "@devchief proposes: settle. This item is ready_to_settle; its record reports cleanup completed on 2026-11-02, with no dependents remaining.",
      }),
    ];
    render(<DecisionDetail decisions={rows} refId="D-70" onBack={vi.fn()} onNavigate={vi.fn()} onAsk={vi.fn()} />, { wrapper });
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("@devchief proposes: settle.");
    expect(screen.getByText(/This item is ready to settle; its record reports/)).toBeTruthy();
    expect(screen.queryByText(/ready_to_settle/)).toBeNull();
  });
  it("run approvals lead the list and never sit beside an open decision on a narrow panel", async () => {
    render(<NeedsPanel onAsk={vi.fn()} lead={<p>Other approvals</p>} />, { wrapper });
    await ready();
    const lead = screen.getByText("Other approvals");
    expect(lead.closest(".gc-needs-list-pane")).toBeTruthy();
    expect(lead.closest(".gc-needs-detail-pane")).toBeNull();
    expect(lead.compareDocumentPosition(screen.getByText("1 open decision")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("heads a paragraph with no short first sentence by its item, and shows the text once", () => {
    const text =
      "The checkout refactor merged on 2026-11-06 and the item is ready_to_settle, but the smoke run on 2026-11-07 still shows one flaky coupon test that I re-ran twice";
    rows = [decision(71, { itemTitle: "Checkout refactor", question: text })];
    render(<DecisionDetail decisions={rows} refId="D-71" onBack={vi.fn()} onNavigate={vi.fn()} onAsk={vi.fn()} />, { wrapper });
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Checkout refactor");
    expect(screen.getAllByText(/The checkout refactor merged on 2026-11-06 and the item is ready to settle/)).toHaveLength(1);
  });
  it("uses safe evidence links and valid definition-list children", () => {
    rows = [
      decision(48, {
        pack: {
          facts: [{ label: "Path", value: "Build → CI" }],
          unblocks: ["R-8"],
          evidence: [
            { kind: "url", label: "Unsafe", url: "javascript:alert(1)" },
            { kind: "pr", label: "Pull request", url: "https://example.test/pr/1" },
            { kind: "item", label: "Item", url: "/areas?item=48" },
            { kind: "code", label: "Code", text: "const x = '<script>';" },
          ],
        },
      }),
    ];
    const { container } = render(<DecisionDetail decisions={rows} refId="D-48" onBack={vi.fn()} onNavigate={vi.fn()} onAsk={vi.fn()} />, { wrapper });
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.getByRole("link", { name: /Pull request/ }).getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "Item" }).getAttribute("target")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("const x = '<script>';");
    expect([...container.querySelector("dl")!.children].every((child) => child.tagName === "DIV")).toBe(true);
    expect(screen.getByText("@devchief")).toBeTruthy();
  });
  it("scopes keyboard choices/confirmation/ask and ignores text fields", async () => {
    const onAsk = vi.fn();
    rows = [decision(48, { risk: ["public"] })];
    const { container } = render(<DecisionDetail decisions={rows} refId="D-48" onBack={vi.fn()} onNavigate={vi.fn()} onAsk={onAsk} />, { wrapper });
    const root = container.querySelector(".gc-needs-detail")!;
    fireEvent.keyDown(root, { key: "1" });
    expect(screen.getByRole("group", { name: "Confirm answer" })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.keyDown(root, { key: "a" });
    expect(onAsk).toHaveBeenCalledWith("D-48");
    const input = document.createElement("input");
    root.appendChild(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.keyDown(root, { key: "Enter" });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });
  it("offers cancellable defer before the API write, then commits after ten seconds", async () => {
    render(<NeedsList decisions={rows} onOpen={vi.fn()} />, { wrapper });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "More actions for D-48" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Defer 1 h" }));
    expect(screen.getByText("Deferring D-48 in 10 s")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions for D-48" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Defer 1 h" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.post).toHaveBeenCalledWith("/api/coordinator/decisions/D-48/defer", { until: expect.any(String) });
  });
  it("reports open counts and announces each ref only once across refetches", async () => {
    const onCount = vi.fn();
    const { container } = render(<NeedsPanel onAsk={vi.fn()} onCount={onCount} />, { wrapper });
    await ready();
    expect(onCount).toHaveBeenCalledWith(1);
    // What was already waiting when the panel opened is not announced as new.
    expect(container.querySelector("[aria-live='polite']")?.textContent).toBe("");
    rows = [decision(48), decision(49)];
    await act(async () => {
      await qc.invalidateQueries({ queryKey: DECISIONS_KEY });
    });
    await waitFor(() => expect(container.querySelector("[aria-live='polite']")?.textContent).toBe("New decision D-49"));
    expect(onCount).toHaveBeenCalledWith(2);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: DECISIONS_KEY });
    });
    expect(container.querySelector("[aria-live='polite']")?.textContent).toBe("New decision D-49");
  });
});
