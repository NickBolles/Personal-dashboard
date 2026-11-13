import { describe, expect, it } from "vitest";
import { RISK_FLAGS, type Decision } from "./cw-decisions";
import type { DecisionEntry } from "./decisions";
import {
  aboutItem,
  answerGate,
  isDangerous,
  questionLines,
  receiptText,
  riskLine,
  rowChoices,
  shortQuestion,
  viewOfDecision,
  viewOfEntry,
} from "./decision-view";

const decision = (extra: Partial<Decision> = {}): Decision => ({
  id: "dec_1",
  ref: "D-52",
  seq: 52,
  itemId: "wk_desk",
  itemTitle: "Standing desk",
  areaTitle: "Household admin",
  runId: null,
  question: "What is the budget ceiling for the desk?",
  choices: ["Up to $400", "Up to $650", "No ceiling"],
  recommended: "Up to $400",
  risk: [],
  pack: {},
  defaultChoice: null,
  expiresAt: null,
  state: "open",
  answeredChoice: null,
  answeredAt: null,
  answeredVia: null,
  deferredUntil: null,
  supersededBy: null,
  raisedBy: "agent:momentumchief",
  createdAt: "2026-11-06T12:00:00.000Z",
  updatedAt: "2026-11-06T12:00:00.000Z",
  ...extra,
});
const entry = (extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
  key: "item:wk_desk",
  kind: "item",
  itemId: "wk_desk",
  title: "Standing desk",
  question: "What is the budget ceiling for the desk?",
  choices: ["Up to $400", "Up to $650"],
  href: "/areas?item=wk_desk",
  at: "2026-11-06T12:00:00.000Z",
  ref: "D-52",
  ...extra,
});

describe("one view of a decision, whichever list it came from", () => {
  it("reads the queue's row and the inbox's entry into the same shape", () => {
    const a = viewOfDecision(decision({ runRef: "R-41" }));
    const b = viewOfEntry(entry({ recommended: "Up to $400", risk: [], runRef: "R-41", askedBy: "momentumchief", areaTitle: "Household admin" }))!;
    expect(a).toMatchObject({ ref: "D-52", itemTitle: "Standing desk", recommended: "Up to $400", blocks: "R-41", raisedBy: "@momentumchief" });
    expect(b).toMatchObject({ ref: "D-52", itemTitle: "Standing desk", recommended: "Up to $400", blocks: "R-41", raisedBy: "@momentumchief" });
  });
  it("only an entry that is a decision with its D-n is a decision", () => {
    expect(viewOfEntry(entry({ kind: "approval" }))).toBeNull();
    expect(viewOfEntry(entry({ kind: "stalled" }))).toBeNull();
    expect(viewOfEntry(entry({ ref: undefined }))).toBeNull();
  });
  it("never invents a recommendation", () => {
    expect(viewOfDecision(decision({ recommended: null })).recommended).toBeNull();
    expect(viewOfDecision(decision({ recommended: "Something not offered" })).recommended).toBeNull();
    expect(viewOfEntry(entry())!.recommended).toBeNull();
  });
  it("names the blocked run from the raising run, else from what the pack says it unblocks", () => {
    expect(viewOfDecision(decision()).blocks).toBeNull();
    expect(viewOfDecision(decision({ pack: { unblocks: ["#252", "R-8", "R-9"] } })).blocks).toBe("R-8");
    expect(viewOfDecision(decision({ runRef: "R-3", pack: { unblocks: ["R-8"] } })).blocks).toBe("R-3");
    expect(viewOfDecision(decision({ runRef: "not a ref" })).blocks).toBeNull();
  });
});

describe("the answer rules", () => {
  it("a risk-flagged decision always takes a second tap, for a listed choice and for free text alike", () => {
    for (const flag of RISK_FLAGS) {
      expect(answerGate({ risk: [flag] }, "Do it")).toBe("confirm");
      expect(answerGate({ risk: [flag] }, "anything typed by hand")).toBe("confirm");
      expect(answerGate({ risk: [flag] }, "Do it", true)).toBe("send");
    }
  });
  it("a low-risk decision answers in one tap; an empty answer never sends", () => {
    expect(answerGate({ risk: [] }, "Do it")).toBe("send");
    expect(answerGate({ risk: [] }, "  ")).toBe("empty");
    expect(answerGate({ risk: ["money"] }, "", true)).toBe("empty");
  });
  it("a row offers chips only for a low-risk decision whose whole question is on the row", () => {
    const v = viewOfDecision(decision());
    expect(rowChoices(v)).toEqual(["Up to $400", "Up to $650", "No ceiling"]);
    expect(rowChoices({ ...v, risk: ["money"] })).toEqual([]);
    const paragraph = `${"The nightly eval has been waiting since Tuesday and accuracy moved by two points, ".repeat(2)}so pick one.`;
    expect(rowChoices({ ...v, question: paragraph })).toEqual([]);
    expect(rowChoices({ ...v, question: "Short lead. Then a second sentence that the row does not show." + " More.".repeat(20) })).toEqual([]);
  });
  it("names the risk and marks the dangerous ones", () => {
    expect(riskLine({ risk: ["money", "public"] })).toBe("Money · Public exposure");
    expect(riskLine({ risk: [] })).toBe("");
    expect(isDangerous({ risk: ["public"] })).toBe(false);
    expect(isDangerous({ risk: ["permission", "destructive"] })).toBe(true);
  });
});

describe("words", () => {
  it("the receipt says what was asked, then what was answered", () => {
    expect(receiptText({ ref: "D-52", question: "Budget ceiling for the desk", itemTitle: "Standing desk" }, "Up to $400")).toBe(
      "D-52 · Budget ceiling for the desk · Up to $400",
    );
  });
  it("shortens a paragraph to its first sentence, or to the item it is about", () => {
    const lead = "Import duplicates found. The second sync on 2026-11-12 created 14 duplicate recipes because source ids changed upstream.";
    expect(shortQuestion({ question: lead, itemTitle: "Recipe box import" })).toBe("Import duplicates found.");
    const run = "The checkout refactor merged on 2026-11-06 and the item is ready_to_settle, but the smoke run still shows one flaky coupon test";
    expect(shortQuestion({ question: run, itemTitle: "Checkout refactor" })).toBe("Checkout refactor");
    expect(shortQuestion({ question: "Item is ready_to_settle?", itemTitle: "X" })).toBe("Item is ready to settle?");
  });
  it("heads a paragraph with no first sentence by its item and keeps the whole text as the body", () => {
    const run =
      "The checkout refactor merged on 2026-11-06 and the item is ready_to_settle, but the smoke run on 2026-11-07 still shows one flaky coupon test that I re-ran";
    const q = questionLines({ question: run, itemTitle: "Checkout refactor" });
    expect(q).toMatchObject({ title: "Checkout refactor", titled: true, readable: false });
    expect(q.rest).toContain("ready to settle");
    expect(questionLines({ question: "Ship tonight?", itemTitle: "Sync fix" })).toEqual({ title: "Ship tonight?", rest: "", titled: false, readable: true });
  });
  it("does not repeat an item title that only restates the question", () => {
    expect(aboutItem({ question: "Rotate the storefront DB password?", itemTitle: "Rotate the storefront DB password", areaTitle: "Portfolio" })).toBe(
      "Portfolio",
    );
    expect(aboutItem({ question: "What is the budget ceiling?", itemTitle: "Standing desk", areaTitle: "Home" })).toBe("Standing desk");
    expect(aboutItem({ question: "What is the budget ceiling?", itemTitle: "Standing desk", areaTitle: "Home" }, true)).toBe("Home");
  });
});
