import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/lib/cw-runs";
import { byNeed, cardStatus, eventChip, latestEvent, proseSaysFailed, stepFailed, stepOutcome } from "./run-card";
import type { CoordinatorRunRow } from "./runs-view";

/**
 * "Step failed" is ONE rule (lib/coordinator/run-card.ts stepOutcome): structured state first, then explicit
 * failure phrases only, with negation and "fixed it" handling. Strings below are real step / run summaries
 * (prod run_events and agent_runs, Hermes sub-agent progress lines, CI notices), lightly redacted, plus the
 * false positives the #272 review found.
 */
const FAILED: string[] = [
  "Re-run 1 of the coupon test: failed again",
  "Vendor portal timed out",
  "Build failed: 2 type errors in lib/coordinator/status.ts",
  "Tests: 3 failed, 120 passed",
  "Failed to push fix/status-last-known: could not read Username for 'https://github.com'",
  "Blocked before fetch/merge: the active execution shell reports GH_TOKEN=unset and GITHUB_TOKEN=unset",
  "Required external completion is blocked: GitHub auth is unavailable so the branch was not pushed",
  "npm ci exited with code 1",
  "Playwright crashed: Target page, context or browser has been closed",
  "Error: ENOSPC: no space left on device",
  "The deploy is broken: /api/health returns 502",
  "Fixed 2 of the 3 flaky specs; agents-chat.spec still failing on desktop",
  "Codex review: 1 P1 — secrets scan errors on the PEM fixture",
  "Approval was denied, so the container swap did not run",
  "Unable to start the dev server: port 3240 is in use",
  "Image build aborted: pids cgroup limit reached",
  "visual-baselines run failed; nothing committed",
  "Can't reach Hermes: 429 max connections reached",
  "Lint errored on eslint-suppressions.json",
  "main CI is red on 4a809cc",
];
const NOT_FAILED: string[] = [
  "Fixed the 3 failing tests",
  "All 12 tests pass, 0 errors",
  "Added error handling to the retry loop",
  "All checks passed with no errors",
  "Build finished: 0 errors, 0 warnings",
  "Typecheck clean; no lint errors",
  "Checks are no longer failing after the rebase",
  "The flaky visual test didn't fail this time",
  "Resolved the 2 type errors Codex flagged",
  "Retrying after a timeout from the GitHub API",
  "Wrote error messages for the empty states",
  "Documented the failure modes of the session-end sweep",
  "Investigating why the earlier smoke failed",
  "Can't reproduce the 320px overflow locally",
  "Pushed fix/status-last-known-snapshot and opened PR #1873",
  "PR #250 merged (795007d) and live in prod (release 63)",
  "Background process finished: wrote the diff",
  "11 of 12 checks passed",
  "Half way through the migration backfill",
  "Added a fail-safe so the watchdog never restarts during a deploy",
  "Toast on error now keeps the draft",
  "Previous run failed on a flake; rerunning the failed shard",
  "Debugged the crash in the radial menu and added a regression test",
  "Zero failing checks on the merge sha",
  "Waiting for CI on the PR head",
];

const ev = (summary: string, over: Partial<RunEvent> = {}): RunEvent => ({
  id: "e1",
  runId: "r1",
  runRef: "R-1",
  type: "notice",
  summary,
  payload: {},
  via: null,
  at: "2026-11-12T16:00:00.000Z",
  ...over,
});

describe("stepOutcome: one rule for 'Step failed'", () => {
  it("has a realistic table of at least 30 strings", () => {
    expect(FAILED.length + NOT_FAILED.length).toBeGreaterThanOrEqual(30);
  });
  it.each(FAILED)("reports a failure: %s", (s) => {
    expect(proseSaysFailed(s)).toBe(true);
    expect(stepFailed(ev(s))).toBe(true);
    expect(eventChip(ev(s))).toEqual({ label: "Step failed", tone: "bad" });
  });
  it.each(NOT_FAILED)("is not a failure: %s", (s) => {
    expect(proseSaysFailed(s)).toBe(false);
    expect(stepFailed(ev(s))).toBe(false);
    expect(eventChip(ev(s)).tone).not.toBe("bad");
  });

  it("prefers structured state over the prose, both ways", () => {
    // Prose says failure, structure says success.
    expect(stepOutcome(ev("Fixed it, the failing deploy is green", { payload: { state: "success" } }))).toBe("ok");
    expect(stepOutcome(ev("Build failed earlier, rerun", { payload: { exitCode: 0 } }))).toBe("ok");
    expect(stepOutcome(ev("errors: none", { payload: { ok: true } }))).toBe("ok");
    // Prose is calm, structure says failure.
    expect(stepOutcome(ev("Ran the suite", { payload: { exit_code: 2 } }))).toBe("bad");
    expect(stepOutcome(ev("Checks", { type: "ci", payload: { conclusion: "failure" } }))).toBe("bad");
    expect(stepOutcome(ev("Checks", { type: "ci", payload: { pipeline: [{ stage: "ci", state: "failed" }] } }))).toBe("bad");
    expect(stepOutcome(ev("Deploy", { payload: { status: "timed_out" } }))).toBe("bad");
    // A stated in-between state is a verdict too: the prose is not read.
    expect(stepOutcome(ev("Build failed?", { payload: { status: "running" } }))).toBeNull();
  });
  it("reads run lifecycle events by type", () => {
    expect(stepOutcome(ev("Finished", { type: "failed" }))).toBe("bad");
    expect(stepOutcome(ev("All errors fixed", { type: "done" }))).toBe("ok");
    expect(stepOutcome(ev("Started", { type: "started" }))).toBeNull();
    expect(stepOutcome(ev("Lock taken after a failed attempt", { type: "lock.acquired" }))).toBeNull();
  });
  it("CI prose: red or green when it says so, else neutral", () => {
    expect(eventChip(ev("Smoke suite started", { type: "ci" })).tone).toBe("inf");
    expect(eventChip(ev("Checks failed on main", { type: "ci" })).tone).toBe("bad");
    expect(eventChip(ev("All checks passed", { type: "ci" })).tone).toBe("ok");
    expect(eventChip(ev("All checks passed with no errors", { type: "ci" })).tone).toBe("ok");
  });
});

const row = (over: Partial<CoordinatorRunRow> = {}): CoordinatorRunRow => ({
  id: "r1",
  ref: "R-1",
  seq: 1,
  itemId: "i1",
  itemTitle: "Item",
  profile: "devchief",
  title: "Smoke tests",
  state: "running",
  stalled: true,
  summary: null,
  prUrl: null,
  parentRunId: null,
  parentRef: null,
  pipeline: [],
  lock: null,
  interruptedAt: null,
  startedAt: "2026-11-12T14:00:00.000Z",
  updatedAt: "2026-11-12T15:00:00.000Z",
  finishedAt: null,
  noticeCount: 0,
  ...over,
});
const NOW = Date.parse("2026-11-12T16:00:00.000Z");

describe("cardStatus: every card says 'Step failed' the same way", () => {
  it("a quiet run whose newest event failed says Step failed (key stays stuck)", () => {
    const s = cardStatus(row(), [ev("Build failed: 2 errors", { at: "2026-11-12T15:00:00.000Z" })], NOW);
    expect(s).toMatchObject({ key: "stuck", label: "Step failed", tone: "bad", failedStep: true });
  });
  it("a quiet run whose newest event fixed the failures stays Quiet", () => {
    const events = [ev("Build failed", { id: "a", at: "2026-11-12T14:30:00.000Z" }), ev("Fixed the 3 failing tests", { id: "b", at: "2026-11-12T15:00:00.000Z" })];
    expect(cardStatus(row(), events, NOW)).toMatchObject({ key: "stuck", label: "Quiet", tone: "wn", failedStep: false });
  });
  it("a working run never says Step failed (it is still reporting)", () => {
    expect(cardStatus(row({ stalled: false }), [ev("Build failed")], NOW)).toMatchObject({ key: "working", failedStep: false });
  });
  it("falls back to the run's own last event", () => {
    const r = row({ lastEvent: ev("npm ci exited with code 1") });
    expect(latestEvent(r, [])?.summary).toBe("npm ci exited with code 1");
    expect(cardStatus(r, [], NOW).failedStep).toBe(true);
  });
  it("Activity ordering uses the same rule", () => {
    const a = row({ id: "a", ref: "R-1", seq: 1, updatedAt: "2026-11-12T15:50:00.000Z" });
    const b = row({ id: "b", ref: "R-2", seq: 2, updatedAt: "2026-11-12T15:00:00.000Z" });
    // R-1 reported a success-with-'errors'-in-it; R-2 really failed a step: R-2 first.
    const events = [ev("All 12 tests pass, 0 errors", { runId: "a" }), ev("Tests: 3 failed", { runId: "b" })];
    expect(byNeed([a, b], events).map((r) => r.ref)).toEqual(["R-2", "R-1"]);
  });
});
