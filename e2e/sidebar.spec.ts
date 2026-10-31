import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/** Desktop Arc sidebar: pin/unpin, reorder, collapse, row ⋯ rename/move, F2/M keyboard editing. */
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "desktop sidebar only");

async function create(page: Page, body: Record<string, unknown>) {
  const r = await appPost(page, "/api/work/items", body);
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { item: { id: string } }).item;
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sidebar" });
const row = (page: Page, title: string) => sidebar(page).getByRole("treeitem", { name: new RegExp(`^${title},`) });

async function expand(page: Page, title: string) {
  const r = row(page, title);
  await expect(r).toBeVisible();
  if ((await r.getAttribute("aria-expanded")) === "false") {
    await r.focus();
    await page.keyboard.press("ArrowRight");
    await expect(r).toHaveAttribute("aria-expanded", "true");
  }
}

test("sidebar: pin and unpin an area, collapse and expand", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const title = `Zephyr ${nonce}`;
  await page.goto("/home");
  await create(page, { kind: "area", title });
  await page.reload();
  await expect(row(page, title)).toBeVisible();

  await sidebar(page)
    .getByRole("button", { name: `More for ${title}` })
    .click();
  await page
    .getByRole("menu", { name: `${title} actions` })
    .getByRole("menuitem", { name: "Pin to sidebar" })
    .click();
  const pinned = page.locator('[aria-label="Pinned areas"]');
  await expect(pinned.getByRole("link", { name: title })).toBeVisible();

  await page.reload();
  await expect(pinned.getByRole("link", { name: title })).toBeVisible();

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar(page).getByRole("tree", { name: "Areas" })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(row(page, title)).toBeVisible();

  await pinned.getByRole("link", { name: title }).hover();
  await page.getByRole("button", { name: `Unpin ${title}` }).click();
  await expect(pinned.getByRole("link", { name: title })).toHaveCount(0);
});

test("sidebar: row ⋯ rename and move, F2 / M / Alt+arrow keyboard editing", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const area = `Quokka ${nonce}`;
  const a = `Kestrel ${nonce}`;
  const b = `Ibis ${nonce}`;
  await page.goto("/home");
  const parent = await create(page, { kind: "area", title: area });
  await create(page, { kind: "project", title: a, parentId: parent.id });
  await create(page, { kind: "project", title: b, parentId: parent.id });
  await page.reload();
  await expand(page, area);
  await expect(row(page, a)).toBeVisible();

  const order = () =>
    sidebar(page)
      .getByRole("treeitem")
      .evaluateAll((els, t) => els.map((e) => e.getAttribute("aria-label") ?? "").filter((l) => t.some((x) => l.startsWith(`${x},`))), [a, b]);
  const before = await order();
  expect(before).toHaveLength(2);

  // Alt+↓ / Alt+↑ reorders the focused row among its siblings.
  const first = before[0].split(",")[0];
  await row(page, first).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => (await order())[1]?.split(",")[0]).toBe(first);
  await row(page, first).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(async () => (await order())[0]?.split(",")[0]).toBe(first);

  // ⋯ → Rename edits inline.
  await sidebar(page)
    .getByRole("button", { name: `More for ${a}` })
    .click();
  await page
    .getByRole("menu", { name: `${a} actions` })
    .getByRole("menuitem", { name: "Rename" })
    .click();
  const input = sidebar(page).getByRole("textbox", { name: `Rename ${a}` });
  await input.fill(`${a} renamed`);
  await input.press("Enter");
  await expect(row(page, `${a} renamed`)).toBeVisible();

  // ⋯ → Move… opens the Move-to picker.
  await sidebar(page)
    .getByRole("button", { name: `More for ${b}` })
    .click();
  await page
    .getByRole("menu", { name: `${b} actions` })
    .getByRole("menuitem", { name: /^Move/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // F2 renames, M moves, from the focused row.
  await row(page, b).focus();
  await page.keyboard.press("F2");
  await expect(sidebar(page).getByRole("textbox", { name: `Rename ${b}` })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sidebar(page).getByRole("textbox", { name: `Rename ${b}` })).toHaveCount(0);
  await row(page, b).focus();
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});
