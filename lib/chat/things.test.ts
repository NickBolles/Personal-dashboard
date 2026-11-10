import { describe, expect, it } from "vitest";
import { chatThings, executionAttentionKey, linkAttentionKey, trayContent, type ChatThingsInput } from "./things";
import type { ChatExecutionResponse, ExecutionRecord } from "@/lib/chat-execution";
import type { PanelLink } from "@/server/chat/links";
const record = (state: ExecutionRecord["state"], id: string = state): ExecutionRecord => ({ key: id, id, title: id, state, source: "subagent" });
const execution = (records: ExecutionRecord[] = []): ChatExecutionResponse => ({
  sessionId: "s",
  records,
  parent: null,
  sources: [{ source: "transcript", state: "ok" }],
  fetchedAt: "2026-11-05T00:00:00Z",
});
const pr: PanelLink = {
  url: "https://github.com/n/r/pull/1",
  title: "PR",
  kind: "github",
  ghType: "pull",
  domain: "github.com",
  pinned: false,
  state: "merged",
};
const base: ChatThingsInput = { links: [], execution: execution(), now: 1000 };
describe("chat things", () => {
  it("orders failing > needs > finished > due step > merged > running > quiet", () => {
    const input: ChatThingsInput = {
      ...base,
      execution: execution([record("failed"), record("completed"), record("running")]),
      pending: { approval: true },
      workflow: { title: "Run", due: true, step: "Next", sections: [] },
      links: [pr],
    };
    expect(chatThings(input).line.state).toBe("failing");
    input.execution = execution([record("completed"), record("running")]);
    expect(chatThings(input).line.state).toBe("needs");
    input.pending = {};
    expect(chatThings(input).line.state).toBe("finished");
    input.execution = execution([record("running")]);
    expect(chatThings(input).line.state).toBe("step");
    input.workflow = null;
    expect(chatThings(input).line.state).toBe("merged");
    input.links = [];
    expect(chatThings(input).line.state).toBe("running");
    input.execution = execution();
    expect(chatThings(input).line.state).toBe("quiet");
  });
  it("uses separate red/yellow/no dot rules and clears viewed attention", () => {
    expect(chatThings({ ...base, execution: execution([record("failed")]) }).line).toMatchObject({ tone: "bad", dot: "red" });
    expect(chatThings({ ...base, execution: execution([record("completed")]) }).line).toMatchObject({ tone: "ok", dot: "yellow" });
    expect(chatThings({ ...base, pending: { clarify: true } }).line).toMatchObject({ tone: "warn", dot: "yellow" });
    expect(chatThings({ ...base, execution: execution([record("running")]) }).line).toMatchObject({ tone: "ai", dot: null });
    expect(chatThings(base).line.dot).toBeNull();
    expect(chatThings({ ...base, execution: execution([record("failed")]), seen: [executionAttentionKey(record("failed"))] }).line.dot).toBeNull();
  });
  it("does not turn missing, errored or stale execution into zero", () => {
    expect(chatThings({ links: [] }).counts.running).toBeNull();
    expect(chatThings({ ...base, executionUnavailable: true }).counts.running).toBeNull();
    expect(chatThings({ ...base, execution: { ...execution(), sources: [{ source: "transcript", state: "stale" }] } }).counts.running).toBeNull();
    expect(chatThings(base).counts.running).toBe(0);
    expect(chatThings({ ...base, executionUnavailable: true, execution: execution([record("running")]) }).counts.running).toBe(1);
    expect(chatThings(base).counts.context).toBeNull();
  });
  it("counts actual link states without inventing CI", () => {
    const result = chatThings({
      ...base,
      links: [pr, { ...pr, url: "second", state: "failed" }, { ...pr, url: "artifact", kind: "artifact" }],
      filesCount: 4,
      contextPercent: 71,
    });
    expect(result.counts).toEqual({ links: 3, artifacts: 1, prs: { total: 2, failing: 1 }, running: 0, files: 4, context: 71 });
  });
  it("new terminal states still need attention after the running record was viewed", () => {
    const seen = [executionAttentionKey(record("running", "child"))];
    expect(chatThings({ ...base, seen, execution: execution([record("completed", "child")]) }).line).toMatchObject({ state: "finished", dot: "yellow" });
    expect(chatThings({ ...base, seen, execution: execution([record("failed", "child")]) }).line.dot).toBe("red");
    expect(chatThings({ ...base, links: [{ ...pr, state: "failed" }], seen: [linkAttentionKey(pr)] }).line.dot).toBe("red");
  });
  it("maps all needs-you inputs and workflow/merge attention without inventing usage", () => {
    for (const pending of [{ approval: true }, { clarify: true }, { decision: true }, { form: true }]) {
      expect(chatThings({ ...base, pending }).line).toMatchObject({ state: "needs", tone: "warn", dot: "yellow" });
    }
    expect(chatThings({ ...base, execution: execution([record("waiting")]) }).line.state).toBe("needs");
    expect(chatThings({ ...base, workflow: { title: "Review", due: true, sections: [] } }).line).toMatchObject({ state: "step", tone: "warn", dot: "yellow" });
    expect(chatThings({ ...base, links: [pr] }).line).toMatchObject({ state: "merged", tone: "warn", dot: "yellow" });
    expect(chatThings({ ...base, contextPercent: NaN }).counts.context).toBeNull();
    expect(chatThings({ ...base, contextPercent: 101 }).counts.context).toBe(100);
  });
  it("keeps the same rank stable for a minute, immediately admits higher ranks and delays downward transitions", () => {
    const input = { ...base, execution: execution([record("running", "a"), record("running", "b")]) };
    const previous = chatThings(input).line;
    expect(chatThings({ ...input, previous, now: 60_999 }).line.id).toBe("a");
    expect(chatThings({ ...input, previous, now: 61_000 }).line.id).toBe("b");
    expect(chatThings({ ...input, previous, pending: { approval: true }, now: 1100 }).line.state).toBe("needs");
    expect(chatThings({ ...base, previous, now: 2000, transitionSince: 1000 }).line.state).toBe("running");
    expect(chatThings({ ...base, previous, now: 5000, transitionSince: 1000 }).line.state).toBe("quiet");
    expect(chatThings({ ...base, previous, execution: execution([record("running", "new")]), now: 2000 }).line.id).toBe("new");
  });
  it("titles background work with the person's words, never the page-context wrapper", () => {
    const run = { ...record("completed", "run"), title: "[Viewing: Todos — /todos] Support skipping a recurring todo" };
    expect(chatThings({ ...base, execution: execution([run]) }).line).toMatchObject({ state: "finished", text: "Support skipping a recurring todo" });
  });
  it("a failed background check is a notice only when it matters, never the headline", () => {
    const stale = { ...execution(), sources: [{ source: "hermes_children" as const, state: "stale" as const }] };
    const down = { ...execution(), sources: [{ source: "jarvis_runs" as const, state: "unavailable" as const }] };
    // The standing "stale" caveat and a still-loading check are not failures.
    expect(chatThings({ ...base, execution: stale, expectsBackground: true }).notice).toBe(false);
    expect(chatThings({ links: [], expectsBackground: true }).notice).toBe(false);
    // A real failure stays quiet in a chat that never started background work…
    expect(chatThings({ ...base, executionUnavailable: true })).toMatchObject({
      notice: false,
      line: { state: "quiet", text: "Everything in this chat, in one place" },
    });
    expect(chatThings({ ...base, execution: down }).notice).toBe(false);
    // …and is said plainly where there is (or was) some.
    expect(chatThings({ ...base, executionUnavailable: true, expectsBackground: true }).notice).toBe(true);
    expect(chatThings({ ...base, execution: down, parentRunning: true }).notice).toBe(true);
    expect(chatThings({ ...base, execution: { ...down, records: [record("running")] } }).notice).toBe(true);
  });
});
describe("tray content", () => {
  it("an idle chat with nothing in it shows nothing", () => {
    expect(trayContent(chatThings(base))).toEqual({ status: null, chips: [], notice: false, empty: true });
    expect(trayContent(chatThings({ links: [] })).empty).toBe(true);
    expect(trayContent(chatThings({ ...base, filesCount: 0, contextPercent: 0 })).chips).toEqual([]);
  });
  it("shows only what exists: zero and unknown counts are never chips", () => {
    const content = trayContent(
      chatThings({
        ...base,
        links: [
          { ...pr, state: "open" },
          { ...pr, url: "a", kind: "artifact" },
        ],
        filesCount: 2,
      }),
    );
    expect(content.status).toBeNull();
    expect(content.chips).toEqual([
      { tab: "PRs", count: 1, tone: "neutral", dot: null },
      { tab: "Artifacts", count: 1, tone: "neutral", dot: null },
      { tab: "Files", count: 2, tone: "neutral", dot: null },
    ]);
    expect(content.empty).toBe(false);
    expect(trayContent(chatThings({ ...base, links: [{ ...pr, state: "failed" }] })).chips).toEqual([{ tab: "PRs", count: 1, tone: "bad", dot: "red" }]);
  });
  it("keeps running, waiting and failed states as the status line", () => {
    expect(trayContent(chatThings({ ...base, parentRunning: true })).status).toMatchObject({ state: "running", label: "Working" });
    expect(trayContent(chatThings({ ...base, pending: { approval: true } })).status).toMatchObject({ state: "needs", tone: "warn", action: "Review" });
    expect(trayContent(chatThings({ ...base, parentFailed: true })).status).toMatchObject({ state: "failing", tone: "bad" });
    // One running thing is the status line itself; the chip appears when it adds a count.
    expect(trayContent(chatThings({ ...base, execution: execution([record("running")]) })).chips).toEqual([]);
    expect(trayContent(chatThings({ ...base, execution: execution([record("running", "a"), record("running", "b")]) })).chips).toEqual([
      { tab: "Running", count: 2, tone: "ai", dot: null },
    ]);
  });
  it("names what the approval or question is about, and never lists the waiting run itself beside it", () => {
    const own: ExecutionRecord = { key: "jarvis_run:run_1", id: "run_1", title: "delete the idle previews", state: "waiting", source: "jarvis_run" };
    // Without the request, the waiting run is all there is to show.
    expect(chatThings({ ...base, execution: execution([own]) }).line).toMatchObject({ state: "needs", text: "delete the idle previews" });
    const asked = chatThings({ ...base, execution: execution([own]), pending: { approval: true, detail: " Recursive\n delete ", runId: "run_1" } });
    expect(asked.line).toMatchObject({ id: "approval", state: "needs", label: "Needs you", text: "Recursive delete", action: "Review" });
    // The status line was on the run before the request arrived: it moves to the request, it does not stick.
    const previous = chatThings({ ...base, execution: execution([own]) }).line;
    expect(
      chatThings({ ...base, execution: execution([own]), previous, pending: { approval: true, detail: "Recursive delete", runId: "run_1" } }).line.id,
    ).toBe("approval");
    expect(chatThings({ ...base, pending: { clarify: true, detail: "Which colour?", runId: "run_1" } }).line).toMatchObject({
      text: "Which colour?",
      action: "Answer",
    });
    expect(chatThings({ ...base, pending: { approval: true } }).line.text).toBe("Approval waiting in the conversation");
    // Another run that is waiting is still its own line.
    const other: ExecutionRecord = { ...own, key: "jarvis_run:run_2", id: "run_2", title: "other work" };
    const onOther = chatThings({ ...base, execution: execution([other]) }).line;
    const both = chatThings({
      ...base,
      execution: execution([own, other]),
      previous: onOther,
      pending: { approval: true, detail: "Recursive delete", runId: "run_1" },
    });
    expect(both.line).toMatchObject({ id: "jarvis_run:run_2", text: "other work" });
  });
  it("a live workflow or a failed check that matters keeps the tray", () => {
    expect(trayContent(chatThings({ ...base, workflow: { title: "Notes", sections: [] } })).empty).toBe(false);
    expect(trayContent(chatThings({ ...base, executionUnavailable: true, expectsBackground: true }))).toMatchObject({
      status: null,
      notice: true,
      empty: false,
    });
  });
});
