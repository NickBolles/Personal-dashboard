import { expect, test } from "@playwright/test";
import { mock } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("initiative card shows Paperclip-derived progress, blockers and next child", async ({ page }) => {
  await page.goto("/initiatives");
  const card = page.getByRole("article", { name: "Enable v5 across the platform" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(/1 of 6 done/);
  await expect(card).toContainText("Blocked (1)");
  await expect(card).toContainText("Configuration migration");
  await expect(card).toContainText("waiting on");
  await expect(card).toContainText("Next:");
  await expect(card.getByRole("link", { name: /Open in Paperclip/ })).toHaveAttribute("href", /\/PAP\/issues\/PAP-200$/);
});

test("todos page groups by due state and supports snooze", async ({ page }) => {
  await page.goto("/todos");
  await expect(page.getByRole("heading", { name: /Overdue/ })).toBeVisible();
  const card = page.locator("article", { hasText: "Call plumber" });
  await card.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Snooze until tomorrow" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Snoozed" })).toBeVisible();
});

test("daily compass starts a Hermes check-in and can be completed", async ({ page }) => {
  await page.goto("/daily-compass");
  await page.getByRole("button", { name: /Start check-in/ }).click();
  await page.waitForURL(/\/chat\/.+/);
  await expect(page.getByRole("heading", { level: 1, name: /Daily Compass/ })).toBeVisible();
  await page.goto("/daily-compass");
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByText("Completed")).toBeVisible();
});

test("skylight and brain pages render source data", async ({ page }) => {
  await page.goto("/skylight");
  await expect(page.getByText("Dentist — Will")).toBeVisible();
  await expect(page.getByText(/Take out recycling/)).toBeVisible();
  await page.goto("/brain");
  await expect(page.getByText("Morning brief")).toBeVisible();
  await expect(page.getByText("Failing ×2")).toBeVisible();
});

test("settings: connections show verified state; notifications categories toggle", async ({ page }) => {
  await page.goto("/settings/connections");
  await expect(page.getByRole("button", { name: /Hermes/ })).toContainText("Verified");
  await page.goto("/settings/notifications");
  const box = page.getByRole("checkbox", { name: /Informational/ });
  await expect(box).not.toBeChecked();
  await box.check();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Informational/ })).toBeChecked();
  await page.getByRole("checkbox", { name: /Informational/ }).uncheck();
});

test("share target pre-fills a Hermes capture", async ({ page }) => {
  await page.goto("/share?title=Recipe&text=Try%20this&url=https%3A%2F%2Fexample.com");
  await expect(page).toHaveURL(/\/chat\?new=1/);
  await expect(page.getByLabel("Ask Hermes or capture something")).toHaveValue(/Recipe\nTry this\nhttps:\/\/example.com/);
});

test("manifest is installable-grade", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  const m = await res.json();
  expect(m.display).toBe("standalone");
  expect(m.start_url).toMatch(/^\/home/);
  expect(m.icons.some((i: { sizes: string; purpose?: string }) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  expect(m.share_target.action).toBe("/share");
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
});

test("API refuses cross-site mutations and unauthenticated calls", async ({ page, playwright, baseURL }) => {
  const noCsrf = await page.request.post("/api/notifications/read-all", { data: {} });
  expect(noCsrf.status()).toBe(403);
  const cross = await page.request.post("/api/notifications/read-all", { data: {}, headers: { "x-jarvis-csrf": "1", origin: "https://evil.example" } });
  expect(cross.status()).toBe(403);
  const anon = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const res = await anon.get("/api/home");
  expect(res.status()).toBe(401);
  await anon.dispose();
});

test("pair a phone from Settings → Phones, then sign it out", async ({ page, playwright, baseURL }) => {
  await page.goto("/settings/phones");
  await page.getByRole("button", { name: "Show pairing code" }).click();
  await expect(page.getByRole("img", { name: /Pairing QR code/ })).toBeVisible();
  const code = (await page.getByTestId("pairing-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // What the Android app does: exchange the code (no cookies), then call the API with the token.
  const phone = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const paired = await (await phone.post("/api/devices/pair", { data: { code, name: "E2E Pixel", appVersion: "1.0.0" } })).json();
  expect(paired.token).toMatch(/^jdv_/);
  const auth = { authorization: `Bearer ${paired.token}` };
  expect((await phone.get("/api/widget/summary", { headers: auth })).status()).toBe(200);

  const row = page.getByRole("listitem").filter({ hasText: "E2E Pixel" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole("button", { name: /Sign out/ }).click();
  await expect(row).toHaveCount(0);
  expect((await phone.get("/api/widget/summary", { headers: auth })).status()).toBe(401);
  await phone.dispose();
});
