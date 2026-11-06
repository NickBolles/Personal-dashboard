import { describe, expect, it } from "vitest";
import { chatThings, executionAttentionKey, linkAttentionKey, type ChatThingsInput } from "./things";
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
});
