import { expect, test } from "@playwright/test";
import { mock, setHa } from "./helpers";

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
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.waitForTimeout(800);
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
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
  await expect(assists).toHaveScreenshot("home-suggestions.png", { mask: MASK.map((m) => page.locator(m)) });
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
