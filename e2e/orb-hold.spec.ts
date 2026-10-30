import { expect, test, type Page } from "@playwright/test";

/**
 * Long-pressing the orb with a real touch (Android) must open the radial map without
 * starting a native text selection / context menu, and every petal must fit on screen.
 */

async function touchHold(page: Page, ms: number) {
  const orb = page.locator('[data-testid="dock-orb"]:visible');
  const b = (await orb.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  return {
    release: async () => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    },
  };
}

for (const [w, h] of [
  [390, 844],
  [412, 915],
  [820, 1180],
  [880, 1000],
  [1000, 880],
]) {
  test(`orb long-press at ${w}x${h}: radial opens, no text selection, petals on screen`, async ({ page }) => {
    await page.setViewportSize({ width: w!, height: h! });
    await page.goto("/areas");
    await expect(page.locator('[data-testid="dock-orb"]:visible')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __ctx: boolean[] }).__ctx = [];
      document.addEventListener("contextmenu", (e) => (window as unknown as { __ctx: boolean[] }).__ctx.push(e.defaultPrevented));
    });
    const hold = await touchHold(page, 700);
    await expect(page.locator('#command-map [data-petal="search"]')).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    const vp = page.viewportSize()!;
    const petals = page.locator("#command-map [data-petal]");
    const n = await petals.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const b = (await petals.nth(i).boundingBox())!;
      expect(b.x, `petal ${i} left`).toBeGreaterThanOrEqual(0);
      expect(b.y, `petal ${i} top`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `petal ${i} right`).toBeLessThanOrEqual(vp.width);
      expect(b.y + b.height, `petal ${i} bottom`).toBeLessThanOrEqual(vp.height - 56);
    }
    await hold.release();
    await expect(page.locator('#command-map [data-petal="search"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    expect(await page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx.every(Boolean))).toBe(true);
  });
}
