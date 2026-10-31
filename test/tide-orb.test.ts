import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The orb glyph is white on the Tide gradient (o1 → o2 → o3). It is a non-text graphic,
// so WCAG 1.4.11 asks ≥3:1 against every stop it can sit on while the gradient flows.
const css = readFileSync("app/globals.css", "utf8");
const token = (n: string) => css.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`))![1]!;
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
};

describe("Tide orb", () => {
  it("uses the Tide stops", () => {
    expect([token("o1"), token("o2"), token("o3")].map((h) => h.toLowerCase())).toEqual(["#3b8070", "#3f8f9f", "#6f8fe8"]);
  });
  it("white glyph clears 3:1 on every gradient stop", () => {
    for (const n of ["o1", "o2", "o3"]) expect(contrast("#ffffff", token(n)), n).toBeGreaterThanOrEqual(3);
  });
  it("orb surfaces use the Tide gradient, not the old accent→purple", () => {
    const dock = css.slice(css.indexOf(".dock-orb {"), css.indexOf("}", css.indexOf(".dock-orb {")));
    expect(dock).toContain("var(--orb)");
    expect(css).not.toContain("#6b3fc4");
  });
});
