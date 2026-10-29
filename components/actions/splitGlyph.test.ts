import { describe, expect, it } from "vitest";
import { splitGlyph } from "./ActionCard";

describe("splitGlyph", () => {
  it("moves a leading emoji into the glyph", () => {
    expect(splitGlyph("🧹 Vacuum the stairs")).toEqual({ glyph: "🧹", text: "Vacuum the stairs" });
    expect(splitGlyph("👨‍👩‍👧 Family dinner")).toEqual({ glyph: "👨‍👩‍👧", text: "Family dinner" });
  });
  it("leaves plain and emoji-only titles alone", () => {
    expect(splitGlyph("Call plumber")).toEqual({ text: "Call plumber" });
    expect(splitGlyph("🎉")).toEqual({ text: "🎉" });
    expect(splitGlyph("Ship it 🚀")).toEqual({ text: "Ship it 🚀" });
  });
});
