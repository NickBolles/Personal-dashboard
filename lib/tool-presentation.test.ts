import { describe, it, expect } from "vitest";
import { presentTool, redactToolText, toolResultState } from "./tool-presentation";
describe("semantic tool presentation", () => {
  it("unwraps Jarvis batches without displaying JSON", () => {
    const v = presentTool(
      "tool_call",
      JSON.stringify({ calls: [{ name: "mcp__jarvis__jarvis_update_item", arguments: { id: "wk_123", summary: "private large body" } }] }),
    );
    expect(v.kind).toBe("jarvis");
    expect(v.label).toBe("Requested item update");
    expect(v.target).toBe("wk_123");
    expect(v.children[0].name).toBe("mcp__jarvis__jarvis_update_item");
    expect(v.label).not.toContain("private");
  });
  it("handles batches, malformed streaming input, unknown tools and bounded recursion", () => {
    expect(presentTool("tool_call", '{"calls":[').label).toBe("Used a tool");
    expect(presentTool("brand_new_tool", "{}").kind).toBe("tool");
    expect(
      presentTool("tool_call", {
        calls: [
          { name: "read_file", arguments: { path: "/a.ts" } },
          { name: "terminal", arguments: { command: "git status" } },
        ],
      }).children.map((c) => c.kind),
    ).toEqual(["file", "terminal"]);
  });
  it("never calls a returned request successful and preserves failure", () => {
    expect(toolResultState('{"proposed":true}')).toBe("returned");
    expect(toolResultState('{"success":false}')).toBe("failed");
    expect(toolResultState('{"error":"no"}')).toBe("failed");
    expect(toolResultState("BLOCKED: approval withdrawn")).toBe("failed");
    expect(toolResultState(undefined, false, false)).toBe("running");
  });
  it("redacts both labels and debug payloads", () => {
    expect(redactToolText("password: hunter222 Bearer abcdefghijkl")).not.toContain("hunter222");
    expect(presentTool("terminal", { command: "token=abcdefghijkl" }).target).not.toContain("abcdefghijkl");
  });
});
