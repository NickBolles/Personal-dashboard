import { expect, test } from "@playwright/test";
import { mock, startConversation } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("approval requested inline, answered, then run completes", async ({ page }) => {
  await startConversation(page, "please delete the build folder");
  const card = page.getByRole("group", { name: "Hermes needs your approval" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("rm -rf build");
  await expect(page.getByText("Needs your approval", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Approve once" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText(/Ran a command/)).toBeVisible();
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("stop stays 'stopping' until Hermes confirms, then shows stopped", async ({ page }) => {
  await startConversation(page, "slow long task please");
  await expect(page.getByText("Working…")).toBeVisible();
  await expect(page.getByText(/Working through this/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Stop the run/ }).click();
  await expect(page.getByText("Stopping…")).toBeVisible();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Done", { exact: true })).toHaveCount(0);
});

test("a dropped stream never shows a false completion; it reconciles", async ({ page }) => {
  await startConversation(page, "drop the connection midway");
  // The mock closes the SSE stream before the terminal event, then completes ~0.3s later.
  await expect(page.getByText(/Reconnecting|Working/).first()).toBeVisible();
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Here's what I found/)).toBeVisible();
});

test("failed runs are reported as failed", async ({ page }) => {
  await startConversation(page, "this should fail");
  await expect(page.getByText("Failed", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("alert").filter({ hasText: "The run failed" })).toBeVisible();
});

test("drafts survive reload and are per conversation", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  const composer = page.getByLabel("Message Hermes");
  await composer.fill("half-written thought");
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel("Message Hermes")).toHaveValue("half-written thought");
  await page.goto("/chat/sess_v5");
  await expect(page.getByLabel("Message Hermes")).toHaveValue("");
});

test("Enter sends, Shift+Enter inserts a newline", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  const composer = page.getByLabel("Message Hermes");
  await composer.fill("line one");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("line two");
  await expect(composer).toHaveValue("line one\nline two");
  await composer.press("Enter");
  await expect(page.getByText(/Got it: "line one/)).toBeVisible({ timeout: 15_000 });
});

test("fork latest state leaves the original unchanged and links both ways", async ({ page }) => {
  await page.goto("/chat/sess_v5");
  await expect(page.getByText("Plan: compatibility audit")).toBeVisible();
  const originalMessages = await page.locator("ol > li").count();
  expect(originalMessages).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Fork latest state" }).click();
  const dialog = page.getByRole("dialog", { name: "Fork latest state" });
  await expect(dialog).toContainText("stay exactly as they are");
  await dialog.getByLabel("Title (optional)").fill("v5 alt plan");
  await dialog.getByRole("button", { name: "Create fork" }).click();
  await page.waitForURL((u) => !u.pathname.endsWith("sess_v5"));
  await expect(page.getByRole("heading", { level: 1, name: "v5 alt plan" })).toBeVisible();
  await expect(page.getByText("Forked from")).toBeVisible();
  await page.getByRole("link", { name: "Enable v5 rollout" }).first().click();
  await expect(page).toHaveURL(/sess_v5/);
  await expect(page.locator("ol > li")).toHaveCount(originalMessages);
  await expect(page.getByRole("link", { name: "v5 alt plan" }).first()).toBeVisible();
});

test("fork from an earlier message needs a first prompt and starts a run", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  await page
    .getByRole("button", { name: /Restart with text through your message/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Restart with text through this message" });
  await expect(dialog.getByRole("button", { name: "Restart with text" })).toBeDisabled();
  await dialog.getByLabel("First prompt").fill("Instead, plan a rainy day");
  await dialog.getByRole("button", { name: "Restart with text" }).click();
  await page.waitForURL(/run=/);
  await expect(page.getByText(/Got it: "Instead, plan a rainy day/)).toBeVisible({ timeout: 15_000 });
});

test("rename and archive via the conversation menu", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("dialog").getByLabel("Title").fill("Morning plan (renamed)");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Morning plan (renamed)" })).toBeVisible();
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archived" })).toBeVisible();
});

test("Track in Paperclip: create once, reuse from another conversation", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Track in Paperclip" }).click();
  const dialog = page.getByRole("dialog", { name: "Track in Paperclip" });
  await dialog.getByLabel("Search Paperclip issues").fill("Enable v5");
  await expect(dialog.getByText("Enable v5 across the platform")).toBeVisible();
  await dialog
    .getByRole("button", { name: /Link to PAP-/ })
    .first()
    .click();
  await expect(page.getByRole("status").filter({ hasText: /Linked to PAP-/ })).toBeVisible();

  // Create a brand-new initiative twice from two conversations → one issue.
  for (const s of ["sess_morning", "sess_v5"]) {
    await page.goto(`/chat/${s}`);
    await page.getByRole("button", { name: "Conversation actions" }).click();
    await page.getByRole("menuitem", { name: "Track in Paperclip" }).click();
    await page.getByRole("button", { name: "Create new initiative" }).click();
    await page.getByLabel("Title").fill("Household budget automation v2");
    await page.getByRole("button", { name: "Create and link" }).click();
    await expect(page.getByRole("status").filter({ hasText: /PAP-\d+/ })).toBeVisible();
  }
  await page.goto("/initiatives");
  await expect(page.getByRole("heading", { name: "Household budget automation v2" })).toHaveCount(1);
});
