import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Raycast-style palette: typed actions with argument chips, a confirm step for
 * every write, the ⌘K action panel, breadcrumb sub-lists (Backspace goes up),
 * and on phones: orb tap opens the palette, orb hold keeps the radial map.
 */

const box = (page: Page) => page.getByRole("combobox", { name: "Search Jarvis" });

/** The shared e2e DB has no "Home" area: make a uniquely named one per test. */
async function makeArea(page: Page, title: string) {
  const r = await appPost(page, "/api/work/items", { kind: "area", title });
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { item: { id: string } }).item.id;
}

async function openWithKeys(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(box(page)).toBeFocused({ timeout: 1000 });
  }).toPass();
}

test("typed action: New item in ‹area› → confirm → created", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const area = `Raycast hearth ${nonce}`;
  await page.goto("/home");
  await makeArea(page, area);
  await page.getByRole("heading", { name: "Now" }).waitFor();
  await openWithKeys(page);
  await box(page).fill(`new item in raycast hearth ${nonce}`);
  const action = page.locator('[data-command="action.new-item"]');
  await expect(action).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-chips")).toContainText(area);
  await box(page).fill(`Raycast gutter ${nonce}`);
  await page.keyboard.press("Enter");
  // never on the first Enter: a confirm step with one primary button
  const confirm = page.getByTestId("palette-confirm");
  await expect(confirm).toContainText(`Create “Raycast gutter ${nonce}” in ${area}?`);
  await expect(confirm.getByRole("button", { name: "Confirm" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/areas\?item=/);
  await expect(page.getByRole("heading", { name: `Raycast gutter ${nonce}` })).toBeVisible();
});

test("action panel and breadcrumb Backspace", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  await makeArea(page, `Raycast lantern ${nonce}`);
  await page.getByRole("heading", { name: "Now" }).waitFor();
  await openWithKeys(page);
  const browse = page.getByRole("option", { name: /Browse areas/ });
  await expect(browse).toBeVisible();
  await browse.click();
  await expect(page.getByTestId("palette-breadcrumb")).toContainText("Areas");
  const home = page.getByRole("option", { name: new RegExp(`^Raycast lantern ${nonce}`) }).first();
  await expect(home).toBeVisible();
  await home.hover();
  // ⌘K / Ctrl+K inside the palette: actions for the active row
  await box(page).press("Control+k");
  const panel = page.getByTestId("palette-actions");
  await expect(panel.getByRole("menuitem", { name: "Open", exact: true })).toBeVisible();
  await expect(panel.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(panel.getByRole("menuitem", { name: "Open in new tab" })).toBeVisible();
  await box(page).press("Escape");
  await expect(panel).toHaveCount(0);
  // Backspace on an empty input goes up one level
  await box(page).press("Backspace");
  await expect(page.getByTestId("palette-breadcrumb")).toHaveCount(0);
  await expect(page.getByRole("option", { name: /Browse areas/ })).toBeVisible();
});

test("phone: orb tap opens the palette, hold shows the radial map", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone orb");
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  const orb = page.locator('[data-testid="dock-orb"]:visible');
  await expect(async () => {
    if (!(await box(page).count())) await orb.click();
    await expect(box(page)).toBeFocused({ timeout: 1000 });
  }).toPass();
  // full-height sheet on phones
  const sheet = page.getByRole("dialog", { name: "Search" });
  const vh = page.viewportSize()!.height;
  expect((await sheet.boundingBox())!.height).toBeGreaterThan(vh * 0.9);
  await page.keyboard.press("Escape");
  await expect(box(page)).toHaveCount(0);
  await expect(async () => {
    if (!(await page.locator("#command-map").count())) {
      await orb.focus();
      await page.keyboard.press("ArrowUp");
    }
    await expect(page.locator('#command-map [data-petal="search"]')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.keyboard.press("Escape");
});
