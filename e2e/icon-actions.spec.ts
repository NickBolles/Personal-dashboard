import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * N5 icon-button entry points: the Areas card coordinator ✦, and the item header's
 * Chat here / Start focused work icons beside ⋯. Each keeps its accessible name, has a
 * tooltip, a ≥40px hit target (44 on phones), and still opens what the old text button did.
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

async function expectTarget(page: Page, name: string | RegExp) {
  const btn = page.getByRole("button", { name });
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox();
  const min = (page.viewportSize()?.width ?? 1280) < 640 ? 44 : 40;
  expect(box!.width).toBeGreaterThanOrEqual(min - 0.5);
  expect(box!.height).toBeGreaterThanOrEqual(min - 0.5);
  expect(await btn.getAttribute("title")).toBeTruthy();
  return btn;
}

test("item header: Chat here and Start focused work are icon buttons next to ⋯, one primary", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id } = await makeItem(page, nonce);
  await page.goto(`/areas?item=${id}`);
  const header = page.locator("article section").first();
  await expect(page.locator("#work-item-title")).toHaveText(`Tamarisk plan ${nonce}`);
  await expectTarget(page, "Chat here");
  const focus = await expectTarget(page, "Start focused work");
  await expect(header.getByRole("button", { name: "More item actions" })).toBeVisible();
  // No leftover text buttons for the same actions.
  await expect(header.getByRole("button", { name: "Start focused work" })).toHaveCount(1);
  await expect(header.getByRole("button", { name: "Chat here" })).toHaveCount(1);
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
