import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/**
 * A whole month with manual input only (AC-04), at 375px (AC-27), with
 * keyboard checks and axe on every finance page.
 */
test.use({ viewport: { width: 375, height: 812 } });

async function axe(page: import("@playwright/test").Page) {
  await expectNoHorizontalOverflow(page);
  const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
}

test("finance: set up, plan a card payment, mark it done, close the month", async ({ page }) => {
  await page.goto("/finance");
  await expect(page.getByText("No accounts yet")).toBeVisible();
  await page.getByRole("link", { name: "Add accounts" }).click();
  await expect(page).toHaveURL(/\/finance\/accounts/);

  for (const [name, kind, basis] of [
    ["Joint checking", "checking", ""],
    ["Savings", "savings", ""],
    ["Visa", "credit_card", "current"],
  ] as const) {
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Kind", { exact: true }).selectOption(kind);
    if (basis) await page.getByLabel("Pay by").selectOption(basis);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("rowheader", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await page.getByLabel("Joint checking", { exact: true }).fill("10000");
  await page.getByLabel("Savings", { exact: true }).fill("48,500.00");
  await page.getByLabel("Visa (amount owed)").fill("1500");
  await page.getByRole("button", { name: "Save balances" }).click();
  await expect(page.getByText("owed 1,500.00")).toBeVisible();
  await axe(page);

  await page.getByRole("link", { name: "Funds & reserve" }).click();
  await page.getByLabel("Checking cushion").fill("2000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Reserve settings saved")).toBeVisible();
  await axe(page);

  await page.getByRole("link", { name: "Overview" }).click();
  await page.getByRole("button", { name: /^Start .* check-in$/ }).click();
  await expect(page).toHaveURL(/\/finance\/checkin\/fci_/);
  await expect(page.getByRole("heading", { level: 1, name: /check-in$/ })).toBeVisible();

  // Keyboard: open the add-action dialog, Escape closes it.
  await page.getByRole("button", { name: "Add action" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add action" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Kind")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // The suggestion is never applied on its own; choosing it opens a prefilled action.
  await expect(page.getByText("Pay 1,500.00 from Joint checking")).toBeVisible();
  await page.getByRole("button", { name: "Use this" }).click();
  await expect(page.getByRole("dialog").getByLabel("Amount")).toHaveValue("1500.00");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Nothing more to pay.")).toBeVisible();
  await axe(page);

  await page.getByRole("button", { name: /^Pay Visa/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Not done after all" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Hide amounts is per device and masks every figure.
  await page.getByLabel("Hide amounts on this device").check();
  await expect(page.getByText("owed 1,500.00")).toHaveCount(0);
  await page.getByLabel("Hide amounts on this device").uncheck();

  await page.getByRole("button", { name: "Close check-in" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close it" }).click();
  await expect(page.getByText(/^Closed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add action" })).toHaveCount(0);
});

test("finance: plan year with an event and the Plan/Actual/Forecast toggle", async ({ page }) => {
  await page.goto("/finance/funds");
  const fund = `Tax ${Date.now() % 100000}`;
  await page.getByLabel("New fund").fill(fund);
  await page.getByRole("button", { name: "Add fund" }).click();
  await expect(page.getByRole("rowheader", { name: fund })).toBeVisible();

  await page.goto("/finance/plan");
  await page.getByRole("button", { name: /^Start \d{4}$/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /plan$/ })).toBeVisible();
  await page.getByRole("button", { name: "Add event" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Event").fill("Q3 estimated tax");
  await d.getByLabel("Estimated amount").fill("-8000");
  await d.getByLabel(fund, { exact: true }).fill("-6000");
  await d.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Not fully allocated to funds")).toBeVisible();
  await page.getByRole("button", { name: "actual", exact: true }).click();
  await expect(page.getByText("Q3 estimated tax")).toHaveCount(0);
  await page.getByRole("button", { name: "forecast", exact: true }).click();
  await expect(page.getByText("Q3 estimated tax")).toBeVisible();
  await axe(page);
});
