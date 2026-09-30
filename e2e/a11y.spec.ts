import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

const PAGES = [
  "/home",
  "/chat",
  "/chat/sess_morning",
  "/alerts",
  "/more",
  "/todos",
  "/home-control",
  "/initiatives",
  "/settings",
  "/settings/connections",
  "/settings/notifications",
  "/brain",
  "/daily-compass",
  "/skylight",
];

for (const path of PAGES) {
  test(`a11y + reflow: ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.waitForTimeout(800);
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      serious.map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(" | ")}`,
      ),
    ).toEqual([]);
  });
}

test("200% text zoom does not cause horizontal scrolling", async ({ page }) => {
  for (const path of ["/home", "/chat/sess_morning", "/alerts"]) {
    await page.goto(path);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page);
  }
});

test("touch targets in primary navigation are at least 44px", async ({ page }) => {
  await page.goto("/home");
  const links = page.getByRole("navigation", { name: "Primary" }).locator("a:visible, button:visible");
  const n = await links.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const box = await links.nth(i).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
});
