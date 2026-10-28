import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mock } from "./helpers";

// Jarvis-built workflow surfaces (no model): the morning brief stages
// Today/Snooze/Skip and applies with readback; the week plan lays blocks out
// around the calendar. Both are off unless Smart replies are on.

const TASKS = [
  { title: "Wfbrief pay plumber", dueDays: -2 },
  { title: "Wfbrief book dentist", dueDays: -3 },
];

async function smart(page: Page, enabled: boolean) {
  const res = await page.request.put("/api/smart/settings", { data: { enabled }, headers: { "x-jarvis-csrf": "1" } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
  await mock(request, "/google/tasks", { tasks: TASKS });
});

test.afterEach(async ({ page, request }) => {
  await smart(page, false);
  await mock(request, "/reset");
});

test("workflow pages explain that Smart replies are off", async ({ page }) => {
  await smart(page, false);
  await page.goto("/areas/brief");
  await expect(page.getByTestId("workflow-off")).toBeVisible();
});

test("morning brief: stage Today on an overdue task → apply → readback", async ({ page }) => {
  await smart(page, true);
  // Load the todos so Jarvis' snapshot has the overdue tasks.
  await page.goto("/todos");
  await expect(page.getByText("Wfbrief pay plumber").first()).toBeVisible({ timeout: 15_000 });

  await page.goto("/areas/brief");
  await expect(page.getByRole("heading", { name: "Morning brief" })).toBeVisible();
  const surface = page.getByTestId("smart-surface").first();
  await expect(surface).toBeVisible({ timeout: 20_000 });
  await expect(surface.getByText("Wfbrief pay plumber")).toBeVisible();

  await surface.getByRole("button", { name: "Today: Wfbrief pay plumber" }).click();
  await expect(surface.getByRole("button", { name: "Today: Wfbrief pay plumber" })).toHaveAttribute("aria-pressed", "true");
  await surface.getByRole("button", { name: "Skip: Wfbrief book dentist" }).click();
  await surface.getByRole("button", { name: /^Apply 1 change$/ }).click();
  await expect(surface.getByRole("button", { name: "Undo: Wfbrief pay plumber" })).toBeVisible({ timeout: 15_000 });

  const axe = await new AxeBuilder({ page: page as never }).include("[data-testid=smart-surface]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test("plan the week renders a week grid with blocks", async ({ page }) => {
  await smart(page, true);
  await page.goto("/todos");
  await expect(page.getByText("Wfbrief pay plumber").first()).toBeVisible({ timeout: 15_000 });

  await page.goto("/areas/plan");
  await expect(page.getByRole("heading", { name: "Plan the week" })).toBeVisible();
  await expect(page.getByTestId("week-plan")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("plan-block").first()).toBeVisible();
});
