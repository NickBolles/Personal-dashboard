import { expect, it } from "vitest";
import { selectEscalation } from "@/lib/item-escalation";
import type { ExternalRun, ItemAgentInfo } from "@/lib/agent-runs";
import type { DecisionEntry } from "@/lib/decisions";
const now = Date.parse("2026-10-29T18:00:00.000Z");
const run = (extra: Partial<ExternalRun> = {}): ExternalRun => ({
  id: "r",
  title: "Trial",
  profile: "devchief",
  state: "running",
  summary: null,
  prUrl: null,
  startedAt: "2026-10-29T16:00:00.000Z",
  updatedAt: "2026-10-29T16:10:00.000Z",
  ...extra,
});
const info = (runs: ExternalRun[]): ItemAgentInfo => ({
  itemId: "wk_one",
  areaId: null,
  title: "One",
  who: null,
  live: "running",
  liveAt: null,
  sessionId: null,
  runs: runs.length,
  prs: [],
  report: null,
  progress: null,
  agentRuns: runs,
});
const decision = (extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
  key: "item:wk_one",
  kind: "item",
  itemId: "wk_one",
  title: "One",
  question: "Which route?",
  choices: ["First", "Second"],
  href: "/areas?item=wk_one",
  at: "2026-10-29T16:00:00.000Z",
  askedBy: "devchief",
  ...extra,
});
it("prioritizes an explicit agent question over stalled and failed runs", () => {
  const selected = selectEscalation("wk_one", [decision()], info([run(), run({ id: "failed", state: "failed" })]), now);
  expect(selected?.kind).toBe("decision");
  expect(selected?.agent).toBe("@devchief");
});
it("does not pretend a human question was agent-raised or show another item's question", () => {
  expect(selectEscalation("wk_one", [decision({ askedBy: undefined }), decision({ itemId: "other" })], undefined, now)).toBeNull();
});
it("uses the existing stall threshold; healthy, waiting and done runs do not escalate", () => {
  expect(selectEscalation("wk_one", [], info([run()]), now)).toMatchObject({ kind: "run", stalled: true });
  for (const r of [run({ updatedAt: "2026-10-29T17:59:00.000Z" }), run({ state: "waiting" }), run({ state: "done" }), run({ updatedAt: "bad" })])
    expect(selectEscalation("wk_one", [], info([r]), now)).toBeNull();
});
it("shows failure but suppresses it when the same agent has a newer run", () => {
  const failed = run({ state: "failed" });
  expect(selectEscalation("wk_one", [], info([failed]), now)).toMatchObject({ kind: "run", stalled: false });
  expect(selectEscalation("wk_one", [], info([failed, run({ id: "new", state: "done", startedAt: "2026-10-29T17:00:00.000Z" })]), now)).toBeNull();
});
it("picks the newest eligible run deterministically", () => {
  const old = run({ id: "old", profile: "homelabchief", updatedAt: "2026-10-29T16:00:00.000Z" });
  const newer = run({ id: "newer", state: "failed", updatedAt: "2026-10-29T17:00:00.000Z" });
  const selected = selectEscalation("wk_one", [], info([old, newer]), now);
  expect(selected?.kind === "run" && selected.run.id).toBe("newer");
});
