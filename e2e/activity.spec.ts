import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Activity timeline (components/work/ActivityFeed.tsx): item Activity tab shows an inline edit
 * with Undo, filters narrow the rows, the global /areas/activity view pages with "Load older".
 * Titles use "Marquetry"/"Tambour" words no other spec uses (filing suggestions are word matches).
 */

async function makeItem(page: Page, nonce: string) {
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Marquetry bench ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const r = await appPost(page, "/api/work/items", { kind: "thread", parentId: areaId, title: `Tambour door ${nonce}` });
  expect(r.ok(), await r.text()).toBeTruthy();
  const id = ((await r.json()) as { item: { id: string } }).item.id;
  return { areaId, id, title: `Tambour door ${nonce}` };
}

const patch = (page: Page, id: string, data: Record<string, unknown>) =>
  page.request.patch(`/api/work/items/${id}`, { data, headers: { "x-jarvis-csrf": "1" } });

test("item activity shows an edit with Undo, and filters narrow it", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { id } = await makeItem(page, nonce);
  expect((await patch(page, id, { summary: `Veneer glue-up ${nonce}` })).ok()).toBeTruthy();
  await page.goto(`/areas?item=${id}`);
  await page.getByRole("tab", { name: "Activity" }).click();
  const feed = page.getByRole("region", { name: "Activity" });
  const editRow = feed.locator(".jv-activity-row", { hasText: "edited summary" });
  await expect(editRow).toBeVisible();
  await expect(feed.locator(".jv-activity-dayh").first()).toHaveText("Today");
  await expect(feed.locator(".jv-activity-row", { hasText: "created" })).toBeVisible();

  // Type filter: only "Created" rows.
  await feed.getByLabel("Type").selectOption("created");
  await expect(editRow).toHaveCount(0);
  await expect(feed.locator(".jv-activity-row", { hasText: "created" })).toBeVisible();
  await feed.getByLabel("Type").selectOption("");
  // Search.
  await feed.getByRole("searchbox", { name: "Search activity" }).fill("nothing-matches-zz");
  await feed.getByRole("searchbox", { name: "Search activity" }).press("Enter");
  await expect(feed.getByText("Nothing matches these filters")).toBeVisible();
  await feed.getByRole("searchbox", { name: "Search activity" }).fill("");
  await expect(editRow).toBeVisible();

  // Undo from the row restores the old summary and spends the op.
  await editRow.getByRole("button", { name: /Undo/ }).click();
  await expect.poll(async () => ((await (await page.request.get(`/api/work/items/${id}`)).json()) as { item: { summary: string } }).item.summary).toBe("");
  await expect(editRow.getByRole("button", { name: /Undo/ })).toHaveCount(0);
});

test("global activity: area filter and Load older paging", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const { areaId, id } = await makeItem(page, `${nonce}g`);
  // 55 edits → more than one 50-row page in this area.
  for (let i = 0; i < 55; i++) expect((await patch(page, id, { nextAction: `Plane edge ${i} ${nonce}` })).ok()).toBeTruthy();
  await page.goto(`/areas/activity?root=${areaId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  const feed = page.getByRole("region", { name: "All activity" });
  await expect(feed.getByLabel("Area")).toHaveValue(areaId);
  const rows = feed.locator(".jv-activity-row");
  await expect(rows).toHaveCount(50);
  await feed.getByRole("button", { name: "Load older" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(50);
  await expect(feed.getByRole("button", { name: "Load older" })).toHaveCount(0);
  // Actor filter: GitHub → nothing in this area.
  await feed.getByLabel("Who").selectOption("github");
  await expect(feed.getByText("Nothing matches these filters")).toBeVisible();
});
