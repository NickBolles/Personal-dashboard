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
  await setHa(request, "lock.front_door_lock", "unlocked");
  await page.goto("/home-control");
  const card = page.locator("section[aria-labelledby=ctl-h] li", { hasText: "Front door lock" }).first();
  await expect(card).toContainText("unlocked");
  await card.getByRole("button", { name: "Lock Front door lock" }).click();
  // Someone locks it physically before we confirm
  await setHa(request, "lock.front_door_lock", "locked");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Yes, lock/ })
    .click();
  await expect(page.getByRole("status").filter({ hasText: /State changed/ })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
  expect(state.haCalls.filter((c: { service: string }) => c.service === "lock")).toHaveLength(0);
});

test("only the safe direction is allowed by default", async ({ page }) => {
  await page.goto("/home-control");
  const controls = page.locator("section[aria-labelledby=ctl-h]");
  await expect(controls.getByRole("button", { name: "Lock Front door lock" })).toBeVisible();
  await expect(controls.getByRole("button", { name: /^Unlock / })).toHaveCount(0);
  await expect(controls.getByRole("button", { name: /^Open / })).toHaveCount(0);
});

test("controls are disabled offline and never queued", async ({ page, context }) => {
  await page.goto("/home-control");
  await expect(page.locator("section[aria-labelledby=ctl-h] button").first()).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText(/Controls are disabled while offline/)).toBeVisible();
  for (const b of await page.locator("section[aria-labelledby=ctl-h] li button").all()) await expect(b).toBeDisabled();
  await context.setOffline(false);
});

test("ask Hermes about my home attaches a snapshot of what Jarvis sees", async ({ page, request }) => {
  await setHa(request, "cover.garage_door", "open", 30);
  await page.goto("/home-control");
  await expect(page.locator("section[aria-labelledby=ctl-h] li").first()).toBeVisible();
  await page.getByRole("link", { name: "Ask Hermes about my home" }).click();
  await expect(page).toHaveURL(/\/chat\?new=1&context=/);
  const context = decodeURIComponent(new URL(page.url()).searchParams.get("context") ?? "");
  expect(context).toContain("Garage door (cover.garage_door)");
  expect(context).toContain("Health:");
});
