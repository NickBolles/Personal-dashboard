import { describe, expect, it } from "vitest";
import { needsTimeDivider, unwrapBrokenLines } from "@/lib/chat-text";

describe("unwrapBrokenLines", () => {
  it("keeps code and fenced blocks untouched", () => {
    const py = 'print(\n  "hello"\n)\nprint("world")';
    expect(unwrapBrokenLines(py)).toBe(py);
    const fenced = "```\nfoo(\n)\n```";
    expect(unwrapBrokenLines(fenced)).toBe(fenced);
  });
  it("joins hard breaks from a pasted sentence", () => {
    expect(unwrapBrokenLines("Forgiveness is about the\nPAST\n; trust is about the\nFUTURE\n.")).toBe(
      "Forgiveness is about the PAST; trust is about the FUTURE.",
    );
  });
  it("keeps intentional line breaks when there is no paste signature", () => {
    expect(unwrapBrokenLines("Milk\nEggs\nBread")).toBe("Milk\nEggs\nBread");
    expect(unwrapBrokenLines("Heartland, Sun Prairie\nReady for notes")).toBe("Heartland, Sun Prairie\nReady for notes");
  });
  it("keeps paragraphs and list lines", () => {
    expect(unwrapBrokenLines("a broken\n, line\n\n- item one\n- item two")).toBe("a broken, line\n\n- item one\n- item two");
  });
});

describe("needsTimeDivider", () => {
  it("shows a divider for the first message and after a 5 minute gap", () => {
    expect(needsTimeDivider(undefined, "2026-11-01T17:02:00Z")).toBe(true);
    expect(needsTimeDivider("2026-11-01T17:02:00Z", "2026-11-01T17:04:00Z")).toBe(false);
    expect(needsTimeDivider("2026-11-01T17:02:00Z", "2026-11-01T17:08:00Z")).toBe(true);
    expect(needsTimeDivider("2026-11-01T17:02:00Z", undefined)).toBe(false);
  });
});
