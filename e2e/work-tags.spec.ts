import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * #111 tags + assignee: inline assign/tag on the item detail (Saved · Undo), palette "Assign to" /
 * "Tag" with a confirm step, and the tag/assignee filters on a project's work list and the activity timeline.
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

  // Assignee: compact button → popover/sheet with search, Agents/People sections and Unassigned
  const assignee = page.getByTestId("assignee-picker").getByRole("button");
  await expect(assignee).toHaveAttribute("data-value", "");
  await assignee.click();
  const who = page.getByRole("dialog", { name: "Assignee" });
  await expect(who.getByRole("option", { name: "Unassigned" })).toHaveAttribute("aria-selected", "true");
  await who.getByRole("combobox").fill("devchief");
  await who.getByRole("option", { name: "@devchief", exact: true }).click();
  await expect(who).toBeHidden();
  await expect(assignee).toHaveAttribute("data-value", "agent:devchief");
  await expect(undoBar(page)).toHaveCount(1);

  // Tags: icon button → filter box; Enter on "Create …" adds a new tag at once, Esc closes
  const tagsBtn = page.getByRole("button", { name: "Edit tags" });
  await tagsBtn.click();
  const tagsBox = page.getByRole("dialog", { name: "Tags" });
  const search = tagsBox.getByRole("combobox", { name: "Search tags" });
  await expect(search).toBeFocused();
  await search.fill(`Bramble Patch ${nonce}`);
  const tag = `bramble-patch-${nonce}`;
  await expect(tagsBox.getByRole("option", { name: `Create “${tag}”` })).toBeVisible();
  await search.press("Enter");
  await expect(page.locator(`.jv-meta [data-tag="${tag}"]`)).toBeVisible();
  // the new tag is listed and checked; Enter on it again toggles it off and back on
  await search.fill(tag);
  await expect(tagsBox.getByRole("option", { name: tag, exact: true })).toHaveAttribute("aria-selected", "true");
  await search.press("Escape");
  await expect(tagsBox).toBeHidden();
  await expect(tagsBtn).toBeFocused();

  // Undo the tag; the assignee stays
  await undoBar(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(`.jv-meta [data-tag="${tag}"]`)).toHaveCount(0);
  await expect(assignee).toHaveAttribute("data-value", "agent:devchief");
  await page.reload();
  await expect(page.getByTestId("assignee-picker").getByRole("button")).toHaveAttribute("data-value", "agent:devchief");

  // keyboard: ↓/↑ move, Enter toggles an existing tag, outside click closes
  await page.getByRole("button", { name: "Edit tags" }).click();
  const box2 = page.getByRole("dialog", { name: "Tags" });
  await box2.getByRole("combobox").fill(tag);
  await expect(box2.getByRole("option", { name: tag, exact: true })).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.locator(`.jv-meta [data-tag="${tag}"]`)).toBeVisible();
  await expect(box2.getByRole("option", { name: tag, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.mouse.click(4, 4);
  await expect(box2).toBeHidden();

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
  // Ctrl K inside an open palette opens the action panel instead, so a retry must not press it again
  // while the palette is already up (a late re-render can take focus right after it opens).
  const open = async () =>
    expect(async () => {
      if (await box.isVisible()) await box.click();
      else await page.keyboard.press("Control+k");
      await expect(box).toBeFocused({ timeout: 1000 });
    }).toPass();

  await open();
  await box.fill("assign to momentumchief");
  await expect(page.locator('[data-command="action.assign-item"]')).toBeVisible();
  // Tab starts the action; the rest of the line becomes the argument query, Enter picks the candidate
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-chips")).toContainText("Assign to");
  await box.fill("momentumchief");
  await expect(page.locator('[role="option"]', { hasText: "momentumchief" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const confirm = page.getByTestId("palette-confirm");
  await expect(confirm).toContainText(`Assign “Tinsmith trellis ${nonce}” to @momentumchief?`);
  await expect(confirm.getByRole("button", { name: "Confirm" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(box).toBeHidden();
  await expect(page.getByTestId("assignee-picker").getByRole("button")).toHaveAttribute("data-value", "agent:momentumchief");

  await open();
  await box.fill(`tag tinsnip-${nonce}`);
  await expect(page.locator('[data-command="action.tag"]')).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-chips")).toContainText("Tag");
  await box.fill(`tinsnip-${nonce}`);
  await expect(page.locator('[role="option"]', { hasText: `tinsnip-${nonce}` }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette-confirm")).toContainText(`#tinsnip-${nonce}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(`.jv-meta [data-tag="tinsnip-${nonce}"]`)).toBeVisible();
  await expect(undoBar(page)).toHaveCount(1);
  await undoBar(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(`.jv-meta [data-tag="tinsnip-${nonce}"]`)).toHaveCount(0);
});

test("filters: project work list and activity timeline by tag and assignee", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  // Area pages show project cards + a tree; the filterable row list lives on project pages, so build the tree under a project.
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Brambleworth yard ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const pr = await appPost(page, "/api/work/items", { kind: "project", parentId: areaId, title: `Tinsmith works ${nonce}` });
  expect(pr.ok(), await pr.text()).toBeTruthy();
  const projectId = ((await pr.json()) as { item: { id: string } }).item.id;
  const mk = async (title: string) => {
    const r = await appPost(page, "/api/work/items", { kind: "thread", parentId: projectId, title });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const one = await mk(`Tinsmith gate ${nonce}`);
  const two = await mk(`Tinsmith trellis ${nonce}`);
  const tag = `thornrow-${nonce}`;
  const p = await page.request.patch(`/api/work/items/${one}`, { data: { tags: [tag], assignee: "agent:homelabchief" }, headers: csrf });
  expect(p.ok(), await p.text()).toBeTruthy();

  await page.goto(`/areas?item=${projectId}`);
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

test("settings: rename a tag, Undo restores it (#154)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { one } = await makeTree(page, nonce);
  const from = `quince-hedge-${nonce}`;
  const to = `quince-row-${nonce}`;
  const r = await page.request.patch(`/api/work/items/${one}`, { data: { tags: [from] }, headers: csrf });
  expect(r.ok(), await r.text()).toBeTruthy();
  await page.goto("/settings/tags");
  const list = page.getByTestId("tags-list");
  await expect(list.locator(`[data-tag="${from}"]`)).toBeVisible();
  await page.getByRole("button", { name: `Rename or merge ${from}` }).click();
  await page.getByLabel(`New name for ${from}`).fill(to);
  await page.getByRole("button", { name: "Save" }).click();
  const bar = page.getByRole("status").filter({ hasText: `Renamed #${from}` });
  await expect(bar).toBeVisible();
  await expect(list.locator(`[data-tag="${to}"]`)).toBeVisible();
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(list.locator(`[data-tag="${from}"]`)).toBeVisible();
  await expect(list.locator(`[data-tag="${to}"]`)).toHaveCount(0);
  const d = await page.request.get(`/api/work/items/${one}`);
  expect(JSON.stringify(await d.json())).toContain(from);
});
