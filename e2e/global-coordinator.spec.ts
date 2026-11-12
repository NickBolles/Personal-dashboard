import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/** Browser-only fixtures: no real Hermes or list aggregation calls. Do not use a real profile. */
async function stubCoordinator(page: Page) {
  const at = new Date().toISOString();
  const session = { id: "gc-test", title: "Portfolio coordinator", pinned: false, archived: false };
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: "gc-test",
        sessionTitle: session.title,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route("**/api/work/decisions*", (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/work/activity**", (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/work/items*", (route) => route.fulfill({ json: { items: [], linkedConversations: [] } }));
  await page.route("**/api/coordinator/decisions*", (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route("**/api/coordinator/runs", (route) =>
    route.fulfill({ json: { runs: [], events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/coordinator/looked", (route) =>
    route.fulfill({ json: { lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/hermes/sessions**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ status: 409, json: { error: "Sending is not part of this test" } });
    if (path.endsWith("/area")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/execution"))
      return route.fulfill({ json: { sessionId: session.id, parent: null, records: [], sources: [{ source: "transcript", state: "ok" }], fetchedAt: at } });
    if (path.endsWith("/files") || path.endsWith("/links-panel")) return route.fulfill({ json: { files: [], links: [] } });
    if (path === "/api/hermes/sessions") return route.fulfill({ json: { sessions: [session], nextOffset: null } });
    return route.fulfill({
      json: {
        session,
        children: [],
        links: [],
        timeline: [
          { kind: "user", id: "u1", text: "Hello", at },
          { kind: "assistant", id: "a1", text: "Ready when you are.", at },
        ],
      },
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubCoordinator(page);
});

test("phone opens the Chief of staff sheet on two pages with fresh Viewing context", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Phone layout");
  await page.goto("/areas");
  const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
  await tray.click();
  let sheet = page.getByRole("dialog", { name: "Chief of staff" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".gc-context")).toContainText("Viewing: Areas");
  // Native showModal keeps the rest of the shell inert and wraps keyboard focus.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await sheet.getByRole("button", { name: "Remove page context" }).click();
  await expect(sheet.locator(".gc-context")).toHaveCount(0);
  // Off is stated, and reversible.
  await expect(sheet.getByText("This page is not shared.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Share page", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(tray).toBeFocused();
  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "More", exact: true }).click();
  await tray.click();
  sheet = page.getByRole("dialog", { name: "Chief of staff" });
  await expect(sheet.locator(".gc-context")).toContainText("Viewing: More");
  await expectNoHorizontalOverflow(page);
});

test("phone sheet reflows at 320px with 200 percent text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Phone reflow");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/areas");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.getByRole("button", { name: "Chief of staff", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Chief of staff" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("desktop rail collapse, expansion and width survive navigation and reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop layout");
  await page.goto("/areas");
  const rail = page.getByRole("complementary", { name: "Chief of staff" });
  await expect(rail).toHaveAttribute("data-open", "true");
  const separator = rail.getByRole("separator", { name: "Resize Chief of staff" });
  await separator.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "380");
  await rail.getByRole("button", { name: "Collapse Chief of staff" }).click();
  await expect(rail).toHaveAttribute("data-open", "false");
  await page.getByRole("navigation", { name: "Sidebar", exact: true }).getByRole("link", { name: "Needs you", exact: true }).click();
  await expect(rail).toHaveAttribute("data-open", "false");
  await page.reload();
  await expect(rail).toHaveAttribute("data-open", "false");
  await rail.getByRole("button", { name: "Expand Chief of staff" }).click();
  await expect(rail).toHaveAttribute("data-open", "true");
  await page.reload();
  await expect(rail).toHaveAttribute("data-open", "true");
  await expect(rail.getByRole("separator")).toHaveAttribute("aria-valuenow", "380");
  await expectNoHorizontalOverflow(page);
});

test("desktop chat panel temporarily owns the coordinator rail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop layout");
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.addInitScript(() => localStorage.setItem("jarvis.gc.open", "true"));
  await page.goto("/chat/gc-test");
  const rail = page.getByRole("complementary", { name: "Chief of staff" });
  await expect(rail).toHaveAttribute("data-open", "false");
  await expect(rail).toHaveCSS("width", "54px");
  await page.getByRole("button", { name: "Collapse chat panel" }).click();
  await expect(rail).toHaveAttribute("data-open", "true");
});
