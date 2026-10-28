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

test("inside the Android app without Firebase, web push is offered (FCM not configured)", async ({ page, context }) => {
  // Headless CI Chromium reports notifications as "denied" unless granted ("web push blocked").
  await context.grantPermissions(["notifications"]);
  await page.goto("/settings/notifications?source=android");
  const status = page.getByTestId("push-status");
  await expect(status).toContainText("This phone:");
  // Headless Chromium may still report "denied" (→ "blocked"); either way the opt-in stays offered.
  await expect(status).toContainText(/web push (off|blocked)/);
  await expect(page.getByTestId("fcm-status")).toHaveText("FCM not configured");
  await expect(page.getByTestId("android-app-webpush-note")).toBeVisible();
  await expect(page.getByTestId("android-app-push-note")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable notifications" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send test notification" })).toBeVisible();
  // Later navigations in the same tab no longer carry ?source=android but still count as the app.
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("fcm-status")).toHaveText("FCM not configured");
  await expect(page.getByRole("button", { name: "Enable notifications" })).toBeVisible();
});

test("inside the Android app with working FCM the web push opt-in is hidden", async ({ page }) => {
  await page.route("**/api/push/capabilities", (route) =>
    route.fulfill({
      json: { fcmConfigured: true, phoneTokens: 1, nativePhonePush: true, webSubscriptions: 0, androidAppSubscriptions: 0 },
    }),
  );
  await page.goto("/settings/notifications?source=android");
  await expect(page.getByTestId("android-app-push-note")).toBeVisible();
  await expect(page.getByTestId("fcm-status")).toHaveText("app push (FCM) on");
  await expect(page.getByRole("button", { name: "Enable notifications" })).toHaveCount(0);
});

test("a plain browser tab keeps the web push controls", async ({ page }) => {
  await page.goto("/settings/notifications");
  await expect(page.getByRole("heading", { name: "Push on this device" })).toBeVisible();
  await expect(page.getByTestId("android-app-push-note")).toHaveCount(0);
  await expect(page.getByTestId("fcm-status")).toHaveCount(0);
  await expect(page.getByTestId("push-status")).toContainText("This device:");
});

test("?search=1 opens search (the app's search shortcut)", async ({ page }) => {
  await page.goto("/home?search=1&source=android");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await expect(page).not.toHaveURL(/search=1/);
});
