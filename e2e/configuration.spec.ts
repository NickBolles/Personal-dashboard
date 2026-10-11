import { expect, test } from "@playwright/test";

test("encrypted export, wrong password, safe preview and explicit replacement", async ({ page }) => {
  await page.goto("/settings/configuration");
  await expect(page.getByRole("heading", { name: "Configuration transfer" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Include stored integration secrets/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Replace matching/ })).not.toBeChecked();
  await page.getByLabel("File password", { exact: true }).fill("e2e-configuration-password");
  await page.getByLabel("Confirm export password").fill("e2e-configuration-password");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download encrypted file" }).click()]);
  expect(download.suggestedFilename()).toBe("jarvis-configuration.encrypted.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const file = Buffer.concat(chunks);
  expect(JSON.parse(file.toString()).cipher).toBe("aes-256-gcm");
  await page
    .getByLabel("Encrypted configuration file", { exact: true })
    .setInputFiles({ name: "fixture.encrypted.json", mimeType: "application/json", buffer: file });
  await page.getByLabel("File password", { exact: true }).fill("incorrect-password-fixture");
  await page.getByRole("button", { name: "Decrypt and preview" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid configuration file or password" })).toHaveText("Invalid configuration file or password");
  await page.getByLabel("File password", { exact: true }).fill("e2e-configuration-password");
  await page.getByRole("button", { name: "Decrypt and preview" }).click();
  const preview = page.getByRole("region", { name: "Import preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("preserve");
  await expect(page.getByRole("button", { name: "Apply reviewed configuration" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /Replace matching/ }).check();
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "Decrypt and preview" }).click();
  await expect(preview).toContainText("replace");
  await expect(page.getByRole("button", { name: "Apply reviewed configuration" })).toBeEnabled();
  // Do not replace this shared E2E instance's connections; atomic apply is exercised against isolated SQLite in unit/API tests.
  await page.getByLabel("File password", { exact: true }).fill("changed-password-fixture");
  await expect(preview).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
