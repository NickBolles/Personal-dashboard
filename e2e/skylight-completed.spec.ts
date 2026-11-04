import { expect, test } from "@playwright/test";
import { mock } from "./helpers";

/**
 * Skylight chores completed today stay visible (mock seed: "Wipe the kitchen counters" is done,
 * "Sort the mail pile" is skipped): Skylight page "Done today", Todos (Skylight source chip) and
 * Today's "Recently completed". Read-only: nothing is written to Skylight.
 */
test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("skylight page lists chores done today apart from the open ones", async ({ page }) => {
  await page.goto("/skylight");
  const done = page.getByRole("region", { name: /Done today/ });
  await expect(done).toContainText("Wipe the kitchen counters", { timeout: 15_000 });
  await expect(page.getByRole("region", { name: /Today’s chores/ })).not.toContainText("Wipe the kitchen counters");
  await expect(page.getByText(/Sort the mail pile/)).toHaveCount(0);
});

test("todos merges Skylight chores behind a Skylight source chip", async ({ page }) => {
  await page.goto("/todos");
  const chip = page.getByLabel("Source");
  await expect(chip.locator("option", { hasText: /^Skylight$/ })).toHaveCount(1, { timeout: 15_000 });
  await chip.selectOption("Skylight");
  await expect(page.getByText(/Take out recycling/).first()).toBeVisible();
  // The heading also holds the count ("Completed recently2"), so match the labelled region.
  const completed = page.getByRole("region", { name: /^Completed recently/ });
  await expect(completed).toContainText("Wipe the kitchen counters");
  // Only Skylight rows while the chip is on.
  await expect(page.getByText("Renew car registration")).toHaveCount(0);
});

test("today shows a Skylight completion under Recently completed", async ({ page }) => {
  // Make sure a sync has stored the completion first.
  await page.request.get("/api/sources/skylight");
  await page.goto("/home");
  const toggle = page.getByRole("button", { name: /Recently completed/ });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  await expect(page.locator("#later-done")).toContainText("Wipe the kitchen counters");
});
