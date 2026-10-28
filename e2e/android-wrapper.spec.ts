import { expect, test } from "@playwright/test";

/** The web app running inside the Jarvis Android app (Trusted Web Activity). */

test("asset links are public JSON for the Jarvis Android package", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const res = await anon.get("/.well-known/assetlinks.json", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = (await res.json()) as Array<{ relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] } }>;
  expect(body[0]?.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
  expect(body[0]?.target.package_name).toBe("com.nickbolles.jarvis");
  expect(body[0]?.target.sha256_cert_fingerprints[0]).toMatch(/^8D:60:31:EB(:[0-9A-F]{2}){28}$/);
  await anon.dispose();
});

test("inside the Android app the web push opt-in is hidden for the whole tab", async ({ page }) => {
  await page.goto("/settings/notifications?source=android");
  await expect(page.getByTestId("android-app-push-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable push on this device" })).toHaveCount(0);
  // Later navigations in the same tab no longer carry ?source=android.
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("android-app-push-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable push on this device" })).toHaveCount(0);
});

test("a plain browser tab keeps the web push controls", async ({ page }) => {
  await page.goto("/settings/notifications");
  await expect(page.getByRole("heading", { name: "Push on this device" })).toBeVisible();
  await expect(page.getByTestId("android-app-push-note")).toHaveCount(0);
});

test("?search=1 opens search (the app's search shortcut)", async ({ page }) => {
  await page.goto("/home?search=1&source=android");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await expect(page).not.toHaveURL(/search=1/);
});
