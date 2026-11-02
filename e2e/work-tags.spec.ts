import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * #111 tags + assignee: inline assign/tag on the item detail (Saved · Undo), palette "Assign to" /
 * "Tag" with a confirm step, and the tag/assignee filters on an area's lists and the activity timeline.
 * Titles use "Brambleworth"/"Tinsmith" words no other spec uses (filing suggestions are word matches).
 */

const csrf = { "x-jarvis-csrf": "1" };

async function makeTree(page: Page, nonce: string) {
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Brambleworth yard ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const mk = async (title: string) => {
    const r = await appPost(page, "/api/work/items", { kind: "thread", parentId: areaId, title });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const one = await mk(`Tinsmith gate ${nonce}`);
  const two = await mk(`Tinsmith trellis ${nonce}`);
  return { areaId, one, two };
}

const undoBar = (page: Page) =>
  page
    .getByRole("status")
    .filter({ hasText: "Saved" })
    .filter({ has: page.getByRole("button", { name: "Undo" }) });

test("item detail: assign and tag inline, Undo restores", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { one } = await makeTree(page, nonce);
  await page.goto(`/areas?item=${one}`);
  await expect(page.locator("#work-item-title")).toHaveText(`Tinsmith gate ${nonce}`);

  const assignee = page.getByLabel("Assignee");
  await expect(assignee.locator("option", { hasText: "@devchief" })).toBeAttached();
  await assignee.selectOption("agent:devchief");
  await expect(assignee).toHaveValue("agent:devchief");
  await expect(undoBar(page)).toHaveCount(1);

  const add = page.getByRole("textbox", { name: "Add tag" }).or(page.getByRole("combobox", { name: "Add tag" }));
  await add.fill(`Bramble Patch ${nonce}`);
  await add.press("Enter");
  const tag = `bramble-patch-${nonce}`;
  await expect(page.locator(`.jv-meta [data-tag="${tag}"]`)).toBeVisible();

  // Undo the tag; the assignee stays
  await undoBar(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(`.jv-meta [data-tag="${tag}"]`)).toHaveCount(0);
  await expect(assignee).toHaveValue("agent:devchief");
  await page.reload();
  await expect(page.getByLabel("Assignee")).toHaveValue("agent:devchief");

  // the change shows in the item's activity in plain words
  const r = await page.request.get(`/api/work/activity?item=${one}`);
  expect(JSON.stringify(await r.json())).toMatch(/assigned/i);
});

test("palette: Assign to and Tag confirm before writing", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { two } = await makeTree(page, nonce);
  await page.goto(`/areas?item=${two}`);
  await expect(page.locator("#work-item-title")).toHaveText(`Tinsmith trellis ${nonce}`);
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  const open = async () =>
    expect(async () => {
      await page.keyboard.press("Control+k");
      await expect(box).toBeFocused({ timeout: 1000 });
    }).toPass();

  await open();
  await box.fill("assign to momentumchief");
  await expect(page.locator('[data-command="action.assign-item"]')).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-chips")).toContainText("momentumchief");
  await page.keyboard.press("Enter");
  const confirm = page.getByTestId("palette-confirm");
  await expect(confirm).toContainText(`Assign “Tinsmith trellis ${nonce}” to @momentumchief?`);
  await expect(confirm.getByRole("button", { name: "Confirm" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Assignee")).toHaveValue("agent:momentumchief");

  await open();
  await box.fill(`tag tinsnip-${nonce}`);
  await expect(page.locator('[data-command="action.tag"]')).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-chips")).toContainText(`tinsnip-${nonce}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette-confirm")).toContainText(`#tinsnip-${nonce}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(`.jv-meta [data-tag="tinsnip-${nonce}"]`)).toBeVisible();
  await expect(undoBar(page)).toHaveCount(1);
  await undoBar(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(`.jv-meta [data-tag="tinsnip-${nonce}"]`)).toHaveCount(0);
});

test("filters: area list and activity timeline by tag and assignee", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { areaId, one, two } = await makeTree(page, nonce);
  const tag = `thornrow-${nonce}`;
  const p = await page.request.patch(`/api/work/items/${one}`, { data: { tags: [tag], assignee: "agent:homelabchief" }, headers: csrf });
  expect(p.ok(), await p.text()).toBeTruthy();

  await page.goto(`/areas?item=${areaId}`);
  const gate = page.locator(`[data-node-row="${one}"]`);
  const trellis = page.locator(`[data-node-row="${two}"]`);
  await expect(gate).toBeVisible();
  await expect(trellis).toBeVisible();
  // chips on the row
  await expect(gate.locator(`[data-tag="${tag}"]`)).toBeVisible();
  await expect(gate.locator('[data-assignee="agent:homelabchief"]')).toBeVisible();

  const filter = page
    .locator('[data-testid$="-filter"]')
    .filter({ has: page.getByLabel("Filter by tag") })
    .first();
  await filter.getByLabel("Filter by tag").selectOption(tag);
  await expect(gate).toBeVisible();
  await expect(trellis).toHaveCount(0);
  await filter.getByLabel("Filter by assignee").selectOption("none");
  await expect(gate).toHaveCount(0);
  await filter.getByRole("button", { name: "Clear filter" }).click();
  await expect(trellis).toBeVisible();

  // activity timeline: only rows about the tagged item
  await page.goto("/areas/activity");
  const feed = page.getByRole("region", { name: "All activity" });
  await expect(feed.getByRole("link", { name: `Tinsmith trellis ${nonce}` }).first()).toBeVisible();
  await page.getByTestId("act-g-meta-filter").getByLabel("Filter by tag").selectOption(tag);
  await expect(feed.getByRole("link", { name: `Tinsmith gate ${nonce}` }).first()).toBeVisible();
  await expect(feed.getByRole("link", { name: `Tinsmith trellis ${nonce}` })).toHaveCount(0);
});
