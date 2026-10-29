import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, mock, startConversation } from "./helpers";

const PAGES = [
  "/home",
  "/home/all?bucket=backlog",
  "/settings/home",
  "/chat",
  "/chat/sess_morning",
  "/alerts",
  "/more",
  "/todos",
  "/home-control",
  "/initiatives",
  "/settings",
  "/settings/connections",
  "/settings/connections#github",
  "/settings/notifications",
  "/settings/phones",
  "/brain",
  "/daily-compass",
  "/skylight",
  "/settings/people",
  "/finance",
  "/finance/accounts",
  "/finance/funds",
  "/finance/plan",
  "/finance/checkin?all=1",
  "/areas",
  "/areas?view=inbox",
  "/areas?view=tree",
  "/areas/timeline",
  "/areas/dashboard",
  "/areas/map",
  "/capture",
  "/settings/ai",
  "/settings/agents",
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

test("approval card: axe clean and no overflow at 200% text zoom (choices + undo states)", async ({ page, request }) => {
  await mock(request, "/reset");
  await startConversation(page, "please delete the build folder");
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const axe = async () => {
    const results = await new AxeBuilder({ page: page as never })
      .include('[data-testid="approval-card"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  };
  await axe();
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page);
  await card.getByRole("button", { name: "Approve once" }).click();
  await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await axe();
  // Undo leaves the request unanswered (still awaiting a choice).
  await card.getByRole("button", { name: "Undo" }).click();
  await expect(card.getByRole("button", { name: "Approve once" })).toBeVisible();
  // Resolve the request so its "needs approval" item doesn't leak into later specs (home-all visual).
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(card).toBeHidden({ timeout: 15_000 });
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
