import { expect, test } from "@playwright/test";
import { mock, setHa } from "./helpers";
import { homeVisual } from "./fixtures/home";
import { alertsVisual, chatVisual, visualNow } from "./fixtures/chat-alerts";

/**
 * Visual snapshots of primary screens. Dynamic text (times, relative dates)
 * is masked. Update with: npm run test:e2e -- --update-snapshots
 */
test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
  await setHa(request, "cover.garage_door", "open", 45);
});

const MASK = ["time", "[data-dynamic]", "p.text-xs", "p.text-sm.text-muted", "header p.text-sm"];

for (const [name, path] of [
  ["home", "/home"],
  ["chat", "/chat/sess_morning"],
  ["alerts", "/alerts"],
  ["more", "/more"],
] as const) {
  test(`visual: ${name}`, async ({ page }) => {
    if (name === "home") {
      // /__mock/reset cannot undo Jarvis-owned Compass completion from pages.spec.
      // Isolate the visual contract, including cached/live reads, from that DB and
      // wall-clock freshness. Real provider/selector behavior is tested separately.
      await page.clock.setFixedTime(new Date(homeVisual.generatedAt));
      await page.route(/\/api\/home(?:\?.*)?$/, (route) => route.fulfill({ json: homeVisual }));
    }
    if (name === "chat" || name === "alerts") {
      await page.clock.setFixedTime(new Date(visualNow));
      await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    }
    if (name === "chat") {
      await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: chatVisual }));
    }
    if (name === "alerts") {
      await page.route(/\/api\/notifications(?:\?.*)?$/, (route) => route.fulfill({ json: alertsVisual }));
    }
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    if (name === "chat") {
      await expect(page.getByText(chatVisual.timeline[2].text!, { exact: true })).toBeVisible();
      await expect(page.locator('header a[href^="/initiatives"]')).toHaveCount(0);
      await expect(page.getByText("8:15 AM", { exact: true })).toHaveCount(2);
    }
    if (name === "alerts") {
      await expect(page.locator("li[data-id] h2")).toHaveText(alertsVisual.notifications.map((n) => n.title));
      await expect(page.getByText("3 unread actionable", { exact: true })).toBeVisible();
    }
    if (name === "home") {
      await expect(page.locator("section[aria-labelledby=now-h] article h3")).toHaveText(homeVisual.now.map((a) => a.title));
      await expect(page.getByText("Last updated", { exact: false })).toHaveCount(0);
    }
    await page.waitForTimeout(800);
    await page.waitForTimeout(500);
    // Playwright also masks invisible matches. Hidden feedback paragraphs inside
    // closed disclosures can otherwise paint over unrelated card titles/badges.
    const masks = name === "home" ? MASK.map((m) => `${m}:visible`) : MASK;
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, mask: masks.map((m) => page.locator(m)) });
  });
}

test("visual: home suggestions and the backlog", async ({ page, request }) => {
  await mock(request, "/google/tasks", { tasks: Array.from({ length: 8 }, (_, i) => ({ title: `Overdue errand ${i + 1}`, dueDays: -(3 + i) })) });
  await page.goto("/home");
  expect((await page.request.delete("/api/home/tuning", { data: { scope: "all" }, headers: { "x-jarvis-csrf": "1" } })).ok()).toBe(true);
  await page.reload();
  const assists = page.locator("section[aria-labelledby=assist-h]");
  await assists.waitFor();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Seeded counts and relative dates are deterministic here; keep the grounding
  // copy and controls visible rather than masking every muted paragraph.
  await expect(assists).toHaveScreenshot("home-suggestions.png");
  await page.goto("/home/all?bucket=backlog");
  await page.locator("#all-items article").first().waitFor();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("home-all.png", { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
});

test("visual: configuration transfer", async ({ page }) => {
  await page.goto("/settings/configuration");
  await expect(page.getByRole("heading", { name: "Configuration transfer" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("configuration-transfer.png", { fullPage: true });
});
