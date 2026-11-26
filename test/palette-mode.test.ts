import { describe, expect, it } from "vitest";
import { modeInput, paletteMode } from "@/lib/palette-mode";

describe("explicit palette prefixes", () => {
  it.each([
    ["", "search", ""],
    ["today", "search", "today"],
    ["why?", "search", "why?"],
    [">", "commands", ""],
    ["> today", "commands", "today"],
    [">   /teaching", "commands", "/teaching"],
    ["?", "chief", ""],
    ["? plan next steps", "chief", "plan next steps"],
    ["!shell", "search", "!shell"],
    ["/teaching Jake", "search", "/teaching Jake"],
    [" > quoted", "search", " > quoted"],
  ])("%j → %s", (input, mode, query) => {
    expect(paletteMode(input)).toEqual({ mode, query });
  });
  it("switching modes preserves text without sending", () => {
    for (const mode of ["search", "commands", "chief"] as const) {
      expect(paletteMode(modeInput(mode, "draft text"))).toEqual({ mode, query: "draft text" });
    }
  });
});
