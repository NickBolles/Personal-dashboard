import { expect, test } from "@playwright/test";
import { BASE_URL } from "../playwright.config";

/** Household people: invite an adult, add a kid with a passcode, check what each can see. Global search. */
test("people: invite an adult; they see their modules and not admin pages", async ({ page, browser }) => {
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Add someone" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Sam");
  await expect(page.getByLabel("Sign-in name")).toHaveValue("sam");
  await page.getByRole("button", { name: "Add Sam" }).click();
  const link = (await page.locator("code").filter({ hasText: "/join?code=" }).textContent())!;
  expect(link).toContain("/join?code=");

  const ctx = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  const sam = await ctx.newPage();
  await sam.goto(new URL(link).pathname + new URL(link).search);
  await expect(sam.getByRole("heading", { name: "Welcome, Sam" })).toBeVisible();
  await sam.getByLabel("Choose a passcode").fill("sam-passcode");
  await sam.getByLabel("Type it again").fill("sam-passcode");
  await sam.getByRole("button", { name: "Join" }).click();
  await expect(sam).toHaveURL(/\/home/);
  await sam.goto("/more");
  await expect(sam.getByRole("link", { name: "Finance" })).toBeVisible();
  await expect(sam.getByRole("link", { name: "Brain" })).toHaveCount(0);
  await sam.goto("/settings");
  await expect(sam.getByRole("link", { name: /^People/ })).toHaveCount(0);
  const res = await sam.goto("/settings/people");
  expect(res?.status()).toBe(404);
  await ctx.close();

  // The invite worked once.
  const again = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  const p2 = await again.newPage();
  await p2.goto(new URL(link).pathname + new URL(link).search);
  await expect(p2.getByText(/wrong, used or expired/)).toBeVisible();
  await again.close();
});

test("people: a kid signs in with their name and sees the calendar, not Hermes", async ({ page, browser }) => {
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Add someone" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Ava");
  await page.getByRole("radio", { name: /^Kid/ }).check();
  await page.getByRole("radio", { name: /^Set a passcode now/ }).check();
  await page.getByLabel(/^Passcode/).fill("ava-passcode");
  await page.getByRole("button", { name: "Add Ava" }).click();
  await expect(page.getByRole("heading", { name: "Ava" })).toBeVisible();

  const ctx = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
  const ava = await ctx.newPage();
  await ava.goto("/login");
  await ava.getByLabel("Your sign-in name").fill("ava");
  await ava.getByLabel("Passcode or PIN").fill("ava-passcode");
  await ava.getByRole("button", { name: "Sign in" }).click();
  await expect(ava).toHaveURL(/\/home/);
  await expect(ava.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Hermes" })).toHaveCount(0);
  expect((await ava.goto("/chat"))?.status()).toBe(404);
  expect((await ava.goto("/finance"))?.status()).toBe(404);
  await ava.goto("/skylight");
  await expect(ava.getByRole("heading", { level: 1, name: "Skylight" })).toBeVisible();
  await ctx.close();
});

test("search: Ctrl K finds a page and opens it", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  // Retry until the page has hydrated and the shortcut is listening.
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(box).toBeFocused({ timeout: 1000 });
  }).toPass();
  await box.fill("skylight");
  await expect(page.getByRole("option", { name: /^Skylight/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/skylight/);
});
