import { expect, test as setup, type Page } from "@playwright/test";
import fs from "node:fs";
import { PASSCODE } from "./helpers";
import { appUrl, authState, mockUrl, serverCount } from "./servers";

/**
 * Full first-run flow through the UI: claim with the setup code, connect and
 * test every integration against the demo server, notifications, install,
 * verify, finish. Saves the signed-in state for the other projects.
 *
 * Each worker has its own server (e2e/servers.ts): one onboarding per server, run side by side, each saving
 * e2e/.auth/state-<i>.json for the worker that owns server i.
 */
for (let i = 0; i < serverCount(); i++) {
  setup.describe(`server ${i}`, () => {
    setup.use({ baseURL: appUrl(i) });
    setup("onboarding: claim, connect, test, finish", async ({ page, request }) => {
      expect((await request.post(`${mockUrl(i)}/__mock/reset`, { data: {} })).ok()).toBeTruthy();
      await onboard(page, i);
    });
  });
}

async function onboard(page: Page, i: number) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Claim this Jarvis" })).toBeVisible();

  // Wrong code is rejected
  await page.getByLabel("Setup code").fill("WRONG");
  await page.getByLabel("Your name").fill("Nick");
  await page.getByLabel("Passcode", { exact: true }).fill(PASSCODE);
  await page.getByLabel("Confirm passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/setup code is not correct/i)).toBeVisible();

  await page.getByLabel("Setup code").fill("E2E-SETUP");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/step=welcome/);

  for (const name of ["Hermes", "Todos", "Daily Compass", "Home Assistant", "Skylight", "Paperclip"]) {
    await page.getByRole("button", { name: "Continue" }).last().click();
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^${name}`) })).toBeVisible();
    await page.getByRole("button", { name: "Use demo values" }).click();
    await page.getByRole("button", { name: "Save & test connection" }).click();
    await expect(page.getByText("Connection verified")).toBeVisible({ timeout: 20_000 });
  }

  await page.getByRole("button", { name: "Continue" }).last().click();
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await page.getByRole("button", { name: "Send test notification" }).click();
  await expect(page.getByText(/Test alert added to your inbox/)).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).last().click();
  await expect(page.getByRole("heading", { level: 1, name: "Install" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).last().click();

  await expect(page.getByRole("heading", { level: 1, name: "Verify & finish" })).toBeVisible();
  await page.getByRole("button", { name: "Re-test all connections" }).click();
  await expect(page.getByRole("button", { name: "Re-test all connections" })).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByText("Failing", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Verified", { exact: true })).toHaveCount(6);

  await page.getByRole("button", { name: "Open Jarvis" }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole("heading", { name: "Now" })).toBeVisible();

  fs.mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: authState(i) });
}
