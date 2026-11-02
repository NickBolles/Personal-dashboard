import { expect, test } from "@playwright/test";

/** Workflows W3: create in the builder → preview → save v2 → restore v1. */

test("workflow builder: create, preview, save a new version, restore v1", async ({ page }) => {
  await page.goto("/workflows/new");
  await expect(page.getByRole("heading", { name: "New workflow", level: 1 })).toBeVisible();

  await page.locator("#wf-name").fill("Choir rehearsal log");
  await page.locator("#wf-slug").fill("choirlog");

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

  // Finance is refused inline and blocks Save.
  await page
    .getByRole("navigation", { name: "Builder sections" })
    .getByRole("button", { name: /^Basics/ })
    .click();
  await page.locator("#wf-area").fill("Finance");
  await expect(page.getByTestId("builder-issues")).toContainText("Finance");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await page.locator("#wf-area").fill("");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\/workflows\/choirlog\/edit$/);
  await expect(page.getByRole("heading", { name: "Edit Choir rehearsal log", level: 1 })).toBeVisible();

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
