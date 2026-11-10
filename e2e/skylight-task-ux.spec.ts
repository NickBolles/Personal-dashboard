import { expect, test } from "@playwright/test";
import { TASK_UX_CLOCKS, skylightTaskUxFixture } from "./fixtures/skylight-task-ux";

// Fully fixture-owned reads: server response/seed time and browser time are identical, including DST.
// Provider write correctness is independently exercised by skylight-write.test.ts's strict HTTP mock.
test.use({ timezoneId: "America/Chicago" });
for (const instant of TASK_UX_CLOCKS) {
  test(`task UX: filtered daily chores and distinct skipped state at ${instant}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(instant));
    const fixture = skylightTaskUxFixture(instant);
    await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (r) => r.fulfill({ json: fixture.source }));
    await page.route(/\/api\/settings$/, (r) => r.fulfill({ json: { timezone: "America/Chicago" } }));
    await page.route(/\/api\/sources\/todos(?:\?.*)?$/, (r) => r.fulfill({ json: { status: fixture.source.status, data: { actions: [], extra: {} } } }));
    for (const path of ["/skylight", "/todos"]) {
      await page.goto(path);
      await expect(page.getByText("Daily today visible", { exact: true })).toBeVisible();
      await expect(page.getByText("Daily overdue visible", { exact: true })).toBeVisible();
      await expect(page.getByText("Weekly tomorrow visible", { exact: true })).toBeVisible();
      await expect(page.getByText("Daily tomorrow hidden", { exact: true })).toHaveCount(0);
      const skipped = page.getByRole("region", { name: path === "/todos" ? /^Skipped recently/ : "Skipped this week" });
      await expect(skipped).toContainText("Skipped routine, not completed");
      await expect(page.getByRole("region", { name: path === "/todos" ? /^Completed recently/ : /^Done this week/ })).not.toContainText(
        "Skipped routine, not completed",
      );
      await page.getByRole("switch", { name: "Show upcoming daily chores" }).click();
      await expect(page.getByText("Daily tomorrow hidden", { exact: true })).toBeVisible();
      await page.getByRole("switch", { name: "Show upcoming daily chores" }).click();
      await expect(page.getByText("Daily tomorrow hidden", { exact: true })).toHaveCount(0);
      const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const title = page.locator(".sk-row .jv-trow h3").first();
      await expect(title).toHaveCSS("-webkit-line-clamp", "none");
      expect(await title.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      await zoom.evaluate((el) => el.remove());
    }
  });
}
