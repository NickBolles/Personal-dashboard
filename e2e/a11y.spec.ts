import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, mock, startConversation } from "./helpers";
import { forceSourceState, SOURCE_STATES } from "./fixtures/states";

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
  "/workouts",
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
  for (const path of [
    "/home",
    "/chat/sess_morning",
    "/alerts",
    "/settings",
    "/todos",
    "/home-control",
    "/settings/people",
    "/workouts",
    "/finance",
    "/finance/plan",
  ]) {
    await page.goto(path);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    // Soft: report every overflowing page in one run instead of stopping at the first.
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("200% text zoom at 1024 (sidebar + header dock) does not cause horizontal scrolling", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "desktop sidebar layout only");
  await page.setViewportSize({ width: 1024, height: 768 });
  for (const path of ["/home", "/areas", "/alerts", "/settings"]) {
    await page.goto(path);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("forced source states: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  for (const name of Object.keys(SOURCE_STATES) as (keyof typeof SOURCE_STATES)[]) {
    await page.unrouteAll();
    const path = await forceSourceState(page, name);
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.waitForTimeout(500);
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect.soft(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${name} ${v.id}`)).toEqual([]);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
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
  // Primary nav (phone bar / tablet top row) plus the header bar's own actions (New, Settings…).
  // The Ask dock is a search field in its own landmark (compact by design), not a nav target.
  const sizes = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'nav[aria-label="Primary"] a, nav[aria-label="Primary"] button, .jv-shell > header a, .jv-shell > header button',
      ),
    ]
      .filter((el) => !el.closest('[role="search"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, w: r.width, h: r.height };
      }),
  );
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.filter((s) => s.w < 44 || s.h < 44)).toEqual([]);
});
