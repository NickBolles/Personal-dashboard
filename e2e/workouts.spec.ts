import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

test("workout: plan, edit, save, resume, finish and import privately", async ({ page }) => {
  await page.goto("/more");
  await page.getByRole("link", { name: "Workouts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workouts", exact: true })).toBeVisible();
  await expect(page.getByLabel("Neck-friendly selection")).toBeChecked();
  await page.getByRole("button", { name: "Start workout", exact: true }).click();
  await expect(page.getByText("Saved in Jarvis · ready to resume")).toBeVisible();
  const weight = page.getByLabel("Leg press set 1 weight");
  await weight.fill("25");
  await page.getByLabel("Leg press set 1 reps").fill("10");
  await page.getByRole("button", { name: "Complete Leg press set 1", exact: true }).click();
  await expect(page.getByText("Saved in Jarvis · ready to resume")).toBeVisible();
  await page.reload();
  await expect(weight).toHaveValue("25");
  await expect(page.getByRole("button", { name: "Undo Leg press set 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Simulate a lost POST response after the real server committed it.
  await page.route("**/api/workouts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("failed");
    await page.unroute("**/api/workouts");
  });
  await page.getByLabel("Session notes").fill("Synthetic gym note");
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByText("Saved in Jarvis · ready to resume")).toBeVisible();
  await page.getByRole("button", { name: "Finish workout" }).click();
  await expect(page.getByText("Workout finished · saved privately in Jarvis")).toBeVisible();
  await expect(page.getByText("Highest load: 25 lb × 10", { exact: false }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: /History ·/ }).click();
  await page.getByText("Import workout JSON", { exact: true }).click();
  const data = {
    schemaVersion: 1,
    profile: { displayName: "Fixture", units: "lb" },
    liftAliases: { Curl: "Machine curl" },
    workouts: [
      {
        id: "e2e-import",
        date: "2026-01-01",
        title: "Imported synthetic session",
        type: "Upper",
        notes: "Private fixture only",
        exercises: [{ name: "Curl", sets: [{ weight: 15, reps: 8.5, side: "left", note: "Partial final rep" }, { note: "Mentioned only" }] }],
      },
    ],
  };
  await page.getByLabel("Workout JSON file").setInputFiles({ name: "synthetic.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("1 imported · 0 already present · saved in Jarvis")).toBeVisible();
  await page.getByText("Imported synthetic session", { exact: true }).click();
  await expect(page.getByText("Original artifact preserved.", { exact: false })).toBeVisible();
  await expect(page.getByText("8.5 reps", { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /History ·/ }).click();
  await expect(page.getByText("Imported synthetic session", { exact: true })).toBeVisible();
});
