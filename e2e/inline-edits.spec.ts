import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Inline edits: tap a field in the item detail (or F2/E on a Today row) to edit
 * it in place. Enter/blur saves, Esc cancels, one "Saved · Undo" bar, and the
 * status select never offers Settle (that stays the deliberate Settle… dialog).
 * Titles use "Inkwell"/"Quillon" words no other spec uses (filing suggestions are word matches).
 */

async function makeItem(page: Page, nonce: string, extra: Record<string, unknown> = {}) {
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Inkwell desk ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const r = await appPost(page, "/api/work/items", { kind: "thread", parentId: areaId, title: `Quillon draft ${nonce}` });
  expect(r.ok(), await r.text()).toBeTruthy();
  const id = ((await r.json()) as { item: { id: string } }).item.id;
  if (Object.keys(extra).length) {
    const p = await page.request.patch(`/api/work/items/${id}`, { data: extra, headers: { "x-jarvis-csrf": "1" } });
    expect(p.ok(), await p.text()).toBeTruthy();
  }
  return { id, title: `Quillon draft ${nonce}` };
}

const heading = (page: Page) => page.locator("#work-item-title");

test("detail: tap the title to edit, Enter saves, Undo restores, Esc cancels", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id, title } = await makeItem(page, nonce);
  await page.goto(`/areas?item=${id}`);
  await expect(heading(page)).toHaveText(title);

  await heading(page).getByRole("button").click();
  const input = page.getByRole("textbox", { name: "Edit title" });
  await expect(input).toBeFocused();
  await input.fill(`Quillon final ${nonce}`);
  await input.press("Enter");
  await expect(heading(page)).toHaveText(`Quillon final ${nonce}`);
  // one Undo bar, and Undo puts the old title back
  const bar = page
    .getByRole("status")
    .filter({ hasText: "Saved" })
    .filter({ has: page.getByRole("button", { name: "Undo" }) });
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(heading(page)).toHaveText(title);

  // Esc cancels without saving
  await heading(page).getByRole("button").click();
  await page.getByRole("textbox", { name: "Edit title" }).fill("Should not stick");
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText(title);
  await page.reload();
  await expect(heading(page)).toHaveText(title);

  // empty title: inline error, nothing saved
  await heading(page).getByRole("button").click();
  await page.getByRole("textbox", { name: "Edit title" }).fill("   ");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "can't be empty" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText(title);
});

test("detail: status select excludes Settle; due date and summary save in place", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id } = await makeItem(page, nonce);
  await page.goto(`/areas?item=${id}`);
  const status = page.locator("#work-status");
  const options = await status.locator("option").allTextContents();
  expect(options).not.toContain("Settled");
  expect(options).toContain("On hold");
  await status.selectOption("on_hold");
  await expect(page.locator('[data-status="on_hold"]')).toBeVisible();

  await page.getByLabel("Due date").fill("2026-12-04");
  await page.getByLabel("Due date").blur();
  await expect(async () => {
    const d = await (await page.request.get(`/api/work/items/${id}`)).json();
    expect(d.item.targetDate).toBe("2026-12-04");
  }).toPass();

  await page.getByRole("button", { name: "Edit summary" }).click();
  const box = page.getByRole("textbox", { name: "Edit summary" });
  await box.fill(`Inkwell summary ${nonce}`);
  await box.blur(); // blur saves
  await expect(page.getByText(`Inkwell summary ${nonce}`)).toBeVisible();
});

test("Today row: F2 renames the focused row title in place", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { title } = await makeItem(page, nonce, { status: "in_progress", nextAction: "Ink the margins" });
  await page.goto("/areas");
  const row = page.getByRole("button", { name: title, exact: true });
  await row.focus();
  await page.keyboard.press("F2");
  const input = page.getByRole("textbox", { name: "Edit title" });
  await expect(input).toBeFocused();
  await input.fill(`Quillon row ${nonce}`);
  await input.press("Enter");
  await expect(page.getByRole("button", { name: `Quillon row ${nonce}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
});
