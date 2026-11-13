import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * N5 icon-button entry points: the Areas card coordinator ✦, and the item header's one ⋯ menu (the kit's
 * menu button: a light icon whose tap area is kept by hit-slop) with the page's one primary action in the
 * Next section. Chat here is a menu entry.
 * Words "Wrenfold"/"Tamarisk" are unique to this spec (filing suggestions are word matches).
 */

async function makeItem(page: Page, nonce: string) {
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Wrenfold yard ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const r = await appPost(page, "/api/work/items", { kind: "thread", parentId: areaId, title: `Tamarisk plan ${nonce}` });
  expect(r.ok(), await r.text()).toBeTruthy();
  return { areaId, id: ((await r.json()) as { item: { id: string } }).item.id };
}

test("item header: one ⋯ menu and one primary action; Chat here lives in the menu", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id } = await makeItem(page, nonce);
  await page.goto(`/areas?item=${id}`);
  const header = page.locator("article section").first();
  await expect(page.locator("#work-item-title")).toHaveText(`Tamarisk plan ${nonce}`);
  // The page's one primary action sits in the Next section; there is no second or third header button.
  const focus = header.getByRole("button", { name: "Start focused work" });
  await expect(focus).toHaveCount(1);
  await expect(header.getByRole("button", { name: "Chat here" })).toHaveCount(0);
  const more = header.getByRole("button", { name: "More item actions" });
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Chat here", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  // Keyboard reachable and still opens the packet dialog.
  await focus.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Start focused work" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("areas overview: the coordinator entry is a ✦ icon on the card and opens the pane", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  await makeItem(page, nonce);
  await page.goto("/areas");
  const card = page.getByTestId("map-area-card").filter({ hasText: `Wrenfold yard ${nonce}` });
  await expect(card).toBeVisible();
  const open = page.getByRole("listitem").filter({ has: card }).getByTestId("coordinator-open");
  await expect(open).toHaveAccessibleName(new RegExp(`^Coordinator chat for Wrenfold yard ${nonce}`));
  const box = (await open.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  // Inside the card's top-right corner, not a separate row under it.
  expect(box.y).toBeLessThan(cardBox.y + 12);
  expect(box.x + box.width).toBeGreaterThan(cardBox.x + cardBox.width - 12);
  expect(box.width).toBeGreaterThanOrEqual(39.5);
  await open.click();
  await expect(page.getByTestId("coordinator-pane")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("coordinator-pane")).toBeHidden();
  await expectNoHorizontalOverflow(page);
});
