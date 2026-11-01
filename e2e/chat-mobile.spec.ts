import { expect, test, type Page } from "@playwright/test";
import { mock, revealMessageMeta } from "./helpers";

// Phone chat interactions (mobile project only): keyboard-aware composer, quiet message meta, "+" sheet.

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

const phoneBar = (page: Page) => page.locator('nav[aria-label="Primary"].fixed');

test("keyboard open: composer sits above it, bottom bar + orb hide, list jumps to latest", async ({ page }) => {
  const { width, height } = page.viewportSize()!;
  await page.goto("/chat/sess_morning");
  const composer = page.getByRole("textbox", { name: /^Message / });
  await expect(composer).toBeVisible();
  await expect(phoneBar(page)).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await composer.click();
  // Simulate the on-screen keyboard: the viewport loses ~45% of its height (interactive-widget=resizes-content).
  const kb = Math.round(height * 0.55);
  await page.setViewportSize({ width, height: kb });
  await expect(page.locator("html")).toHaveAttribute("data-kb", "open");
  await expect(phoneBar(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Jarvis commands" })).toBeHidden();
  const box = await composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(kb);
  // Docked directly above the keyboard (no gap where the bottom bar was).
  expect(box!.y + box!.height).toBeGreaterThan(kb - 40);
  // The latest message is visible above the composer.
  await expect(page.locator('[data-testid="msg-bubble"]').last()).toBeInViewport();
  // Tapping + while typing keeps the keyboard up (focus stays in the text field) and opens the sheet in place.
  await page.getByRole("button", { name: "Add to message" }).click();
  await expect(page.getByRole("menu", { name: "Add to message" })).toBeVisible();
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Add to message" })).toBeHidden();
  // Keyboard closes: the bar comes back.
  await composer.blur();
  await page.setViewportSize({ width, height });
  await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open");
  await expect(phoneBar(page)).toBeVisible();
});

test("message time + actions are hidden until the message is tapped", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  const bubble = page.locator('[data-testid="msg-bubble"][data-who="user"]').first();
  await expect(bubble).toBeVisible();
  const firstMeta = bubble.locator("xpath=..").getByTestId("msg-meta");
  await expect(firstMeta).toHaveCSS("position", "absolute");
  // A centred time divider shows the first message's time instead of a meta row under every message.
  await expect(page.locator(".chat-time-divider").first()).toBeVisible();
  const meta = await revealMessageMeta(page, "user");
  await expect(meta.getByRole("button", { name: /^Copy / })).toBeVisible();
  await expect(meta.getByRole("button", { name: /Restart with text through your message/ })).toBeVisible();
  await bubble.click({ position: { x: 4, y: 4 } });
  await expect(firstMeta).toHaveCSS("position", "absolute");
});

test("composer: one + sheet on phones gives the text field the width", async ({ page }) => {
  await page.goto("/chat/sess_morning");
  const composer = page.getByRole("textbox", { name: /^Message / });
  await expect(composer).toBeVisible();
  for (const name of ["Attach context", "Attach files or pictures", "Take a photo"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await expect(page.getByTestId("model-chip")).toBeHidden();
  const vw = page.viewportSize()!.width;
  expect((await composer.boundingBox())!.width).toBeGreaterThan(vw * 0.55);

  const add = page.getByRole("button", { name: "Add to message" });
  await add.click();
  const menu = page.getByRole("menu", { name: "Add to message" });
  for (const item of [/^Context/, /^Attach file/, /^Camera/, /^Photo library/, /^Model/]) {
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();

  // Model lives in the sheet now.
  await add.click();
  await menu.getByRole("menuitem", { name: /^Model/ }).click();
  await expect(page.getByRole("dialog", { name: "Model" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Context opens the context sheet.
  await add.click();
  await menu.getByRole("menuitem", { name: /^Context/ }).click();
  await expect(page.getByRole("dialog", { name: "Add context" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Photo library picks pictures into the same attachment tray.
  await expect(page.getByTestId("chat-library-input")).toHaveAttribute("accept", "image/*");
});
