import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Fast search (palette + composer @): conversations are found by title from
 * the cached index / filed nodes (never a live Hermes list per keystroke),
 * and an @-picked chat is attached to the message as context.
 */

async function newChat(page: Page, title: string) {
  const r = await appPost(page, "/api/hermes/sessions", { title });
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { id: string }).id;
}

test("palette: typing part of a chat title finds it under Chats & notes and opens it", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const id = await newChat(page, `Lecture jotting ${nonce}`);
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(box).toBeFocused({ timeout: 1000 });
  }).toPass();
  await box.fill(`jotting ${nonce}`);
  const hit = page.getByRole("option", { name: new RegExp(`Lecture jotting ${nonce}`) });
  await expect(hit).toBeVisible({ timeout: 5000 });
  await expect(hit).toContainText("Chats & notes");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(id)}$`));
});

test("composer @: picks a chat by title and attaches it as context", async ({ page }) => {
  test.setTimeout(90_000);
  const nonce = Date.now().toString(36);
  const target = await newChat(page, `Seminar jotting ${nonce}`);
  const here = await newChat(page, `Asking about seminars ${nonce}`);
  await page.goto(`/chat/${encodeURIComponent(here)}`);
  const composer = page.locator("#composer");
  await composer.fill(`Summarise @chat:${nonce}`);
  const popover = page.getByTestId("composer-popover");
  const option = popover.getByRole("option", { name: new RegExp(`Seminar jotting ${nonce}`) });
  await expect(option).toBeVisible({ timeout: 5000 });
  await option.hover();
  await composer.press("Enter");
  await expect(composer).toHaveValue(`Summarise @Seminar jotting ${nonce} `);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = page.locator(`[data-ref="chat:${target}"]`);
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent).toHaveText(`@Seminar jotting ${nonce}`);
  await expect(page.getByText("Context Jarvis attached").first()).toBeVisible();
});
