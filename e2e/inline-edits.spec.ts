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
  await expect(status).toBeAttached();
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
  await expect(page.locator(".jv-inline-date-text")).toHaveText(/^Due Dec 4/);

  await page.getByRole("button", { name: "Edit summary" }).click();
  const box = page.getByRole("textbox", { name: "Edit summary" });
  await box.fill(`Inkwell summary ${nonce}`);
  await box.blur(); // blur saves
  await expect(page.getByText(`Inkwell summary ${nonce}`, { exact: true })).toBeVisible();
});

test("Today row: F2 renames the focused row title in place", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { title } = await makeItem(page, nonce, { status: "in_progress", nextAction: "Ink the margins" });
  // /areas opens on the portfolio overview; Today's work queue (with its F2-renamable rows) is /areas/today.
  await page.goto("/areas/today");
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

test("detail ⋯: Abandon… and Mark superseded… close the item with an optional reason (#114)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id, title } = await makeItem(page, nonce);
  await page.goto(`/areas?item=${id}`);
  await expect(heading(page)).toHaveText(title);

  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Abandon…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Abandon ${title}`);
  await dialog.getByLabel("Why stop? (optional)").fill("Quillon pen discontinued");
  await dialog.getByRole("button", { name: "Abandon", exact: true }).click();
  await expect(page.locator('[data-status="abandoned"]')).toBeVisible();
  // the status edit is undoable like any other
  const bar = page.getByRole("status").filter({ has: page.getByRole("button", { name: "Undo" }) });
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('[data-status="captured"]')).toBeVisible();

  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Mark superseded…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark superseded", exact: true }).click();
  await expect(page.locator('[data-status="superseded"]')).toBeVisible();
  // closed items offer Reopen, not Abandon/Superseded again
  await page.getByRole("button", { name: "More item actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Abandon…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("undoing a next-action edit after Start focused work is refused with a clear message (#113)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id } = await makeItem(page, nonce);
  await page.goto(`/areas?item=${id}`);
  await page.getByRole("button", { name: "Edit next action" }).click();
  await page.getByRole("textbox", { name: "Edit next action" }).fill(`Ink the Quillon ${nonce}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const bar = page.getByRole("status").filter({ has: page.getByRole("button", { name: "Undo" }) });
  await expect(bar).toBeVisible();
  // Start focused work (→ in progress) happens before the Undo tap.
  const r = await appPost(page, `/api/work/items/${id}/packets`, { objective: "Quillon ship", nextAction: `Ink the Quillon ${nonce}` });
  expect(r.ok(), await r.text()).toBeTruthy();
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/Can't undo: in-progress work needs a next action/)).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-status="in_progress"]')).toBeVisible();
  await expect(page.getByText(`Ink the Quillon ${nonce}`).first()).toBeVisible();
});
