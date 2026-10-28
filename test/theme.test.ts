// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { applyAppearance, setDensityPref, setThemePref, getThemePref } from "@/lib/client/theme";

describe("appearance preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-density");
  });

  it("follows the OS by default (no attribute)", () => {
    applyAppearance();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(getThemePref()).toBe("system");
  });

  it("pins and unpins the theme", () => {
    setThemePref("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    setThemePref("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("ignores garbage in storage", () => {
    localStorage.setItem("jarvis.theme", "neon");
    applyAppearance();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("pins density", () => {
    setDensityPref("compact");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  });
});
