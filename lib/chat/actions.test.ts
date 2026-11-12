import { describe, expect, it } from "vitest";
import { actionRows, plainActionLabel, summarizeActions, type ChatAction } from "./actions";

const action = (extra: Partial<ChatAction> = {}): ChatAction => ({
  id: "t1:created",
  kind: "created",
  label: "Created",
  title: "Retry policy",
  itemId: "wk_retry",
  runId: null,
  undoOpId: null,
  href: "/areas?item=wk_retry",
  at: null,
  ...extra,
});
const run = (id: string, extra: Partial<ChatAction> = {}) =>
  action({ id: `${id}:run_started`, kind: "run_started", label: "Run started", title: null, runId: id, ...extra });
const delegated = (count: number) =>
  action({ id: `d${count}:delegated`, kind: "delegated", label: `${count} sub-agents`, title: "Audit retries", count, href: null, itemId: null });

describe("plain action wording", () => {
  it("says what happened without orchestration jargon", () => {
    expect(plainActionLabel(action())).toBe("Created");
    expect(plainActionLabel(run("arun_1"))).toBe("Started a run");
    expect(plainActionLabel(delegated(2))).toBe("Handed off to 2 agents");
    expect(plainActionLabel(delegated(1))).toBe("Handed off to 1 agent");
    expect(plainActionLabel(action({ kind: "decision" }))).toBe("Asked you to decide");
    expect(plainActionLabel(action({ kind: "quick_action" }))).toBe("Proposed a quick action");
  });
});

describe("summarizeActions", () => {
  it("counts kinds together in order of first appearance", () => {
    expect(summarizeActions([])).toBe("");
    expect(summarizeActions([action()])).toBe("Created 1 item");
    expect(summarizeActions([action(), run("arun_1"), action({ id: "t2:created" }), run("arun_2")])).toBe("Created 2 items, started 2 runs");
    expect(summarizeActions([delegated(2), delegated(1), action({ kind: "filed" })])).toBe("Handed off to 3 agents, filed this chat");
  });
  it("keeps the line short: past three kinds the rest is a count", () => {
    const many = [
      action(),
      run("arun_1"),
      run("arun_2"),
      delegated(2),
      action({ kind: "updated" }),
      action({ kind: "note" }),
      action({ kind: "note", id: "n2" }),
    ];
    expect(summarizeActions(many)).toBe("Created 1 item, started 2 runs, handed off to 2 agents, +3 more");
  });
});

describe("actionRows", () => {
  it("folds repeats nothing distinguishes and keeps the row's link", () => {
    const rows = actionRows([action(), run("arun_1"), run("arun_2"), action({ id: "t9:updated", kind: "updated", label: "Updated" })]);
    expect(rows.map((r) => [r.full, r.count])).toEqual([
      ["Created · Retry policy", 1],
      ["Started 2 runs", 2],
      ["Updated · Retry policy", 1],
    ]);
    expect(rows[1].action.href).toBe("/areas?item=wk_retry");
  });
  it("never folds actions that differ for the owner: another title, another destination, their own Undo, a delegation", () => {
    expect(actionRows([run("arun_1", { title: "Bisect A" }), run("arun_2", { title: "Bisect B" })]).map((r) => r.full)).toEqual([
      "Started a run · Bisect A",
      "Started a run · Bisect B",
    ]);
    expect(actionRows([run("arun_1"), run("arun_2", { href: "/areas?item=wk_other", itemId: "wk_other" })])).toHaveLength(2);
    expect(actionRows([action({ id: "a", kind: "updated", undoOpId: "op_1" }), action({ id: "b", kind: "updated", undoOpId: "op_2" })])).toHaveLength(2);
    expect(actionRows([delegated(2), { ...delegated(2), id: "again:delegated" }])).toHaveLength(2);
  });
});
