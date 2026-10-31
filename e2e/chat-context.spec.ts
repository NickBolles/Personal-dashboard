import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, mock, startConversation } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("Add context sheet: search, keyboard multi-select, chips, Esc", async ({ page }) => {
  await startConversation(page, "quokka context sheet check");
  await expect(page.getByText(/Got it: "quokka/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Attach context" }).click();
  const sheet = page.getByRole("dialog", { name: "Add context" });
  await expect(sheet).toBeVisible();
  const search = sheet.getByRole("combobox", { name: "Search context" });
  await expect(search).toBeFocused();
  const options = sheet.getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 10_000 });
  const first = (await options.first().locator("span.truncate").first().textContent())?.trim() ?? "";
  await page.keyboard.press("Enter");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  if ((await options.count()) > 1) {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "false");
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: `Remove context ${first}` }).first()).toBeVisible();
  // Finance is never offered.
  await page.getByRole("button", { name: "Attach context" }).click();
  await page.getByRole("combobox", { name: "Search context" }).fill("finance");
  await expect(page.getByRole("dialog", { name: "Add context" }).getByRole("option", { name: /finance/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("an artifact shared in a reply lands in Links (one row per artifact)", async ({ page }) => {
  await startConversation(page, "please share the zephyr board");
  await expect(page.getByText(/Published:/)).toBeVisible({ timeout: 15_000 });
  const vw = page.viewportSize()?.width ?? 0;
  let panel = page.getByRole("complementary", { name: "Context and links" });
  if (vw < 1100) {
    await page.getByTestId("links-button").click();
    panel = page.getByRole("dialog", { name: "Context & links" });
  }
  const row = panel.locator('[data-kind="artifact"]');
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("zephyr-board-e2e");
  await expect(row.getByRole("link", { name: /^Open / })).toHaveAttribute("href", "https://artifacts.ai.nickbolles.com/v/zephyr-board-e2e/");
  await row.getByRole("button", { name: /^Pin / }).click();
  await expect(row.getByRole("button", { name: /^Unpin / })).toBeVisible();
});

test("context sheet and Links: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  await startConversation(page, "please share the zephyr board");
  await expect(page.getByText(/Published:/)).toBeVisible({ timeout: 15_000 });
  const axe = async (label: string) => {
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect.soft(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label} ${v.id}`)).toEqual([]);
  };
  await page.getByTestId("links-button").click();
  const dialog = page.getByRole("dialog", { name: "Context & links" });
  await expect(dialog.locator('[data-kind="artifact"]')).toHaveCount(1, { timeout: 15_000 });
  await axe("links");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Attach context" }).click();
  await expect(page.getByRole("dialog", { name: "Add context" }).getByRole("option").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await axe("sheet");
  await page.keyboard.press("Escape");
});
