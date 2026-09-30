import { expect, test } from "@playwright/test";
import { mock } from "./helpers";

test("keyboard-only: reach the composer, send, and use a dialog with focus restore", async ({ page, request }) => {
  await mock(request, "/reset");
  await page.goto("/chat/sess_morning");
  // Skip link jumps to main content
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  // Focus the composer by keyboard
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (await page.getByLabel("Message Hermes").evaluate((el) => el === document.activeElement)) break;
  }
  await expect(page.getByLabel("Message Hermes")).toBeFocused();
  await page.keyboard.type("keyboard hello");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Got it: "keyboard hello/)).toBeVisible({ timeout: 15_000 });

  // Dialog: open via keyboard, Escape closes and focus returns to the trigger
  const trigger = page.getByRole("button", { name: "Conversation actions" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // first item: Rename
  await expect(page.getByRole("dialog", { name: "Rename conversation" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});
