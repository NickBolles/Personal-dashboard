import { expect, test } from "@playwright/test";

/** Workflows W3: create in the builder → preview → save v2 → restore v1. */

test("workflow builder: create, preview, save a new version, restore v1", async ({ page }, testInfo) => {
  // A retry must not collide with the slug the failed attempt already saved.
  const slug = `choirlog${testInfo.retry || ""}`;
  await page.goto("/workflows/new");
  await expect(page.getByRole("heading", { name: "New workflow", level: 1 })).toBeVisible();

  // Under load the first fill can land before hydration and be reset: fill until it sticks.
  await expect(async () => {
    await page.locator("#wf-name").fill("Choir rehearsal log");
    await page.locator("#wf-slug").fill(slug);
    await page.waitForTimeout(300);
    await expect(page.locator("#wf-name")).toHaveValue("Choir rehearsal log", { timeout: 1000 });
    await expect(page.locator("#wf-slug")).toHaveValue(slug, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await page
    .getByRole("navigation", { name: "Builder sections" })
    .getByRole("button", { name: /^Forms/ })
    .click();
  await page.getByRole("group", { name: "Add a field" }).getByRole("button", { name: "+ date", exact: true }).click();
  await page.locator("#wf-f-label").fill("Rehearsal date");
  await page.locator("#wf-f-default").selectOption("$today");
  await page.getByRole("checkbox", { name: "Required" }).check();

  const preview = page.getByTestId("builder-preview");
  await expect(preview).toContainText("Rehearsal date *");
  await expect(preview).toContainText("(today)");
  await preview.getByRole("radio", { name: "Errors" }).click();
  await expect(preview).toContainText("Rehearsal date is required");

  // Finance is allowed; only an area's explicit AI policy may exclude it.
  await page
    .getByRole("navigation", { name: "Builder sections" })
    .getByRole("button", { name: /^Basics/ })
    .click();
  await page.locator("#wf-area").fill("Finance");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  await page.locator("#wf-area").fill("");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${slug}/edit$`));
  await expect(page.getByRole("heading", { name: "Edit Choir rehearsal log", level: 1 })).toBeVisible({ timeout: 15_000 });

  await page
    .getByRole("navigation", { name: "Builder sections" })
    .getByRole("button", { name: /^Instructions/ })
    .click();
  await page.locator("#wf-instructions").fill("Track each piece we rehearse and the notes the director gives.");
  await expect(page.getByText(/tokens ·/)).toBeVisible();
  await page.locator("#wf-note").fill("Director notes");
  await page.getByRole("button", { name: "Save new version" }).click();

  const history = page.getByRole("region", { name: "Version history" });
  await expect(history).toContainText("v2");
  await expect(history).toContainText("Director notes");
  await history.getByRole("listitem").filter({ hasText: "v2" }).getByRole("button", { name: "Changes" }).click();
  await expect(page.getByTestId("version-diff")).toContainText("instructions");

  await history.getByRole("button", { name: "Restore v1" }).click();
  await expect(history).toContainText("Restored v1");
  await page
    .getByRole("navigation", { name: "Builder sections" })
    .getByRole("button", { name: /^Instructions/ })
    .click();
  await expect(page.locator("#wf-instructions")).toHaveValue("Organise my notes as I go.");
});
