// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AppearanceCard } from "@/app/(shell)/settings/AppearanceCard";
import { setThemePref } from "@/lib/client/theme";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
});

it("applies theme and density immediately and restores device defaults", () => {
  render(<AppearanceCard />);
  const theme = within(screen.getByRole("radiogroup", { name: "Theme" }));
  fireEvent.click(theme.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem("jarvis.theme")).toBe("dark");
  const density = within(screen.getByRole("radiogroup", { name: "Density" }));
  for (const label of ["Touch", "Comfortable", "Compact"]) {
    fireEvent.click(density.getByRole("radio", { name: label }));
    expect(document.documentElement.getAttribute("data-density")).toBe(label.toLowerCase());
  }
  fireEvent.click(theme.getByRole("radio", { name: "System" }));
  fireEvent.click(density.getByRole("radio", { name: "Auto" }));
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(document.documentElement.hasAttribute("data-density")).toBe(false);
});

it("reads saved preferences on mount", () => {
  setThemePref("light");
  render(<AppearanceCard />);
  expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
});
