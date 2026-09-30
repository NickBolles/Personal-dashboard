import { expect, test } from "@playwright/test";
import { appPost, mock, setHa, workerTick } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("home-critical condition creates one deduplicated alert that deep-links to context", async ({ page, request }) => {
  await setHa(request, "alarm_control_panel.wausau_alarm", "triggered", 1);
  await page.goto("/alerts");
  await workerTick(page);
  await workerTick(page); // repeated source event must not duplicate
  await page.reload();
  const item = page.locator("li", { hasText: "House alarm: Alarm triggered" });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Critical");
  await expect(item).toContainText("seen 2 times");
  // Badge counts unread actionable items
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /Alerts, \d+ unread/ })
      .first(),
  ).toBeAttached();
  await item.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/home-control\?entity=alarm_control_panel.wausau_alarm/);
  await setHa(request, "alarm_control_panel.wausau_alarm", "disarmed");
});

test("read, dismissed and acted are distinct states", async ({ page }) => {
  await appPost(page, "/api/notifications/test");
  await page.goto("/alerts");
  const id = await page.locator("li", { hasText: "Test notification" }).filter({ hasText: "Unread" }).first().getAttribute("data-id");
  const item = page.locator(`li[data-id="${id}"]`);
  await expect(item).toContainText("Unread");
  await item.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Mark read" }).click();
  await expect(item).not.toContainText("Unread");
  await item.getByRole("button", { name: "Mark done" }).click();
  await expect(item).toContainText("Done");
  await item.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect(item).toBeHidden();
  await page.getByRole("tab", { name: /All, including dismissed/ }).click();
  await expect(page.locator(`li[data-id="${id}"]`)).toContainText("Dismissed");
  await expect(page.locator(`li[data-id="${id}"]`)).toContainText("Done");
});
