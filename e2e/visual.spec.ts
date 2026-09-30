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
