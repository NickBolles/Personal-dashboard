import { describe, expect, it } from "vitest";
import { formatWorked, summarizeSteps } from "./WorkSummary";

describe("summarizeSteps", () => {
  it("counts steps by verb in first-seen order", () => {
    expect(
      summarizeSteps([
        { tool: "web_search" },
        { tool: "terminal" },
        { tool: "read_file" },
        { tool: "terminal" },
        { tool: "search_files" },
        { kind: "commentary" },
      ]),
    ).toBe("searched 2 sources, ran 2 commands, read 1 file");
  });
  it("falls back to tools and subagents", () => {
    expect(summarizeSteps([{ tool: "todo" }, { kind: "subagent" }])).toBe("used 1 tool, delegated 1 task");
  });
});

describe("formatWorked", () => {
  it("formats seconds and minutes", () => {
    expect(formatWorked(14.2)).toBe("Worked for 14s");
    expect(formatWorked(125)).toBe("Worked for 2m 5s");
    expect(formatWorked(undefined)).toBe("Worked");
  });
});
