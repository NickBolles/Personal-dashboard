import { expect, test } from "@playwright/test";
import { mock, setHa } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("allowlisted control requires confirmation and reports success only after readback", async ({ page, request }) => {
  await setHa(request, "cover.garage_door", "open", 20);
  await page.goto("/home-control?entity=cover.garage_door");
  const card = page.locator("section[aria-labelledby=ctl-h] li", { hasText: "Garage door" }).first();
  await expect(card).toContainText("open");
  await card.getByRole("button", { name: "Close Garage door" }).click();
  const dialog = page.getByRole("dialog", { name: /Close Garage door\?/ });
  await expect(dialog).toContainText("Current state: open");
  await dialog.getByRole("button", { name: /Yes, close/ }).click();
  await expect(page.getByText("Waiting for Home Assistant to confirm…")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Confirmed: closed" })).toBeVisible({ timeout: 15_000 });
});

test("state changed since the user looked → rejected, nothing sent", async ({ page, request }) => {
  await setHa(request, "lock.front_door_lock", "locked");
  await page.goto("/home-control");
  const card = page.locator("section[aria-labelledby=ctl-h] li", { hasText: "Front door lock" }).first();
  await expect(card).toContainText("locked");
  await card.getByRole("button", { name: "Unlock Front door lock" }).click();
  // Someone unlocks it physically before we confirm
  await setHa(request, "lock.front_door_lock", "unlocked");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Yes, unlock/ })
    .click();
  await expect(page.getByRole("status").filter({ hasText: /State changed/ })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
  expect(state.haCalls.filter((c: { service: string }) => c.service === "unlock")).toHaveLength(0);
});

test("controls are disabled offline and never queued", async ({ page, context }) => {
  await page.goto("/home-control");
  await expect(page.locator("section[aria-labelledby=ctl-h] button").first()).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText(/Controls are disabled while offline/)).toBeVisible();
  for (const b of await page.locator("section[aria-labelledby=ctl-h] li button").all()) await expect(b).toBeDisabled();
  await context.setOffline(false);
});
