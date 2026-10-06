import { expect, test } from "@playwright/test";

/** Swappable assistant: add a Claude key in Settings, pick Claude for a new conversation, get a streamed reply. */
test("assistant: a Claude conversation next to Hermes", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Anthropic API key").fill("mock-anthropic-key");
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(page.getByText("Claude: ready")).toBeVisible();

  await page.goto("/chat");
  await page.getByRole("group", { name: "Ask" }).first().getByRole("button", { name: "Claude" }).click();
  await page.getByLabel("Ask Hermes or capture something").fill("What should we cook tonight?");
  await page.getByRole("button", { name: "Send to Hermes" }).click();
  await page.waitForURL(/\/chat\/loc_/);
  await expect(page.getByText(/Claude · Claude Opus 5.5/)).toBeVisible();
  await expect(page.getByText(/You asked: "What should we cook tonight\?"/)).toBeVisible({ timeout: 15_000 });

  // Back to Hermes for the next one (the choice is remembered per device).
  await page.goto("/chat");
  await page.getByRole("group", { name: "Ask" }).first().getByRole("button", { name: "Hermes" }).click();
});
