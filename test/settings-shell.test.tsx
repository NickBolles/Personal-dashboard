// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccessProvider } from "@/components/access";
import { SettingsShell } from "@/app/(shell)/settings/SettingsShell";
import { settingsSections } from "@/app/(shell)/settings/sections";
const nav = vi.hoisted(() => ({ path: "/settings/agents" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
afterEach(cleanup);
it("marks the current section, uses the shared list and adds no h1", () => {
  nav.path = "/settings/agents";
  render(
    <AccessProvider value={{ role: "admin", modules: [], capabilities: ["admin", "work.use"] }}>
      <SettingsShell>
        <h1>Agents</h1>
      </SettingsShell>
    </AccessProvider>,
  );
  const sections = within(screen.getByRole("navigation", { name: "Settings sections" }));
  expect(sections.getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  expect(sections.getByRole("link", { name: "Notifications" }).getAttribute("aria-current")).toBeNull();
  expect(sections.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
    "/settings",
    ...settingsSections(true, () => true).map((s) => s.href),
  ]);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});
it("leaves the index's own navigation alone and respects capability filtering", () => {
  nav.path = "/settings";
  render(
    <SettingsShell>
      <h1>Settings</h1>
    </SettingsShell>,
  );
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(settingsSections(false, () => false).map((s) => s.href)).not.toContain("/settings/agents");
  expect(settingsSections(false, () => false).map((s) => s.href)).not.toContain("/settings/tags");
  expect(settingsSections(false, () => false).map((s) => s.href)).toContain("/settings#appearance");
});
