import { expect, it } from "vitest";
import { scopeChip, scopeIsCommand, scopeLabel, scopeMessage, scopePlaceholder, scopeSendsEmpty, type ComposeScope } from "./compose";

const run: ComposeScope = { kind: "steer", ref: "R-39", title: "Checkout refactor: smoke tests" };

it("steering a tracked run sends the line the coordinator already understands", () => {
  expect(scopeChip(run)).toBe("R-39");
  expect(scopePlaceholder(run)).toBe("Steer R-39…");
  expect(scopeMessage(run, "  skip the\n flaky spec ")).toBe("Steer R-39 (Checkout refactor: smoke tests): skip the flaky spec");
  expect(scopeIsCommand(run)).toBe(true);
  expect(scopeSendsEmpty(run)).toBe(false);
  expect(scopeLabel(run)).toBe("Steering R-39: Checkout refactor: smoke tests");
});

it("steering a sub-agent goes to its own handle, not to the run that tracks it", () => {
  const sub: ComposeScope = { kind: "steer", ref: "R-39", title: "Smoke tests", handle: "sa_7" };
  expect(scopeMessage(sub, "use staging")).toBe("Steer sa_7: use staging");
  expect(scopeMessage({ ...sub, kind: "reply" }, "yes")).toBe("Steer sa_7: yes");
});

it("a reply to work with no reference is a line about it", () => {
  const failed: ComposeScope = { kind: "reply", title: "Price lumber for the garage shelving" };
  expect(scopeChip(failed)).toBe("Price lumber for the ga…");
  expect(scopePlaceholder(failed)).toBe("Reply to this work…");
  expect(scopeMessage(failed, "try the other supplier")).toBe('About "Price lumber for the garage shelving": try the other supplier');
});

it("retry can be sent as it is, or with a note", () => {
  const retry: ComposeScope = { kind: "retry", ref: "R-40", title: "Nightly eval baseline", verb: "Retry" };
  expect(scopeChip(retry)).toBe("Retry R-40");
  expect(scopeSendsEmpty(retry)).toBe(true);
  expect(scopeMessage(retry, "")).toBe("Retry R-40 (Nightly eval baseline).");
  expect(scopeMessage(retry, "with more memory")).toBe("Retry R-40 (Nightly eval baseline). with more memory");
  expect(scopeMessage({ ...retry, verb: "Resume" }, "")).toBe("Resume R-40 (Nightly eval baseline).");
  expect(scopeChip({ ...retry, verb: "Resume" })).toBe("Resume R-40");
});

it("a question is an ordinary message; a decision asks for an answer in your own words", () => {
  const ask: ComposeScope = { kind: "ask", ref: "D-52", title: "What is the budget ceiling for the desk?" };
  expect(scopeIsCommand(ask)).toBe(false);
  expect(scopePlaceholder(ask)).toBe("Answer D-52 in your own words…");
  expect(scopeMessage(ask, "under $500 if it has two motors")).toBe("About D-52 (What is the budget ceiling for the desk?): under $500 if it has two motors");
  expect(scopePlaceholder({ kind: "ask", ref: "R-36", title: "Recipe box dedupe" })).toBe("Ask about R-36…");
});
