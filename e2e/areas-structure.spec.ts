import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/**
 * Areas structure (docs/work.md "Areas structure"): type-aware pages, inline
 * add with paths, convert, bulk move and bulk filing of unfiled conversations.
 */

type Item = { id: string; title: string; parentId: string | null; kind: string; archived: boolean };
const H = { "x-jarvis-csrf": "1" };

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const r = await page.request.post(path, { data, headers: H });
  expect(r.ok(), `${path} ${r.status()}`).toBeTruthy();
  return (await r.json()) as T;
}
async function items(page: Page) {
  return ((await (await page.request.get("/api/work/items")).json()) as { items: Item[] }).items;
}
const tree = (page: Page) => page.getByRole("tree", { name: "Areas" });
const row = (page: Page, title: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`) });

test("build structure: area page, inline path add, project page, decluttered item page, convert", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const area = `Bets ${nonce}`;
  await page.goto("/areas?view=tree");
  await expect(tree(page)).toBeVisible();

  // "New area" row at the end of the tree → inline input.
  await tree(page).getByRole("treeitem", { name: "New area" }).click();
  await page.getByLabel("New area name").fill(area);
  await page.getByLabel("New area name").press("Enter");
  await expect(row(page, area)).toBeVisible();
  await page.getByLabel("New area name").press("Escape");

  // Empty area guides to the first project; a path creates the project and the item in one go.
  await tree(page)
    .getByRole("treeitem", { name: `Add the first project to ${area}` })
    .click();
  const input = page.getByLabel(`New item in ${area}`);
  await input.fill("Scoring engine / Cache warmup");
  await input.press("Enter");
  await expect(row(page, "Scoring engine")).toHaveAttribute("aria-label", /project/);
  await expect(row(page, "Cache warmup")).toBeVisible();
  await input.press("Escape");
  const all = await items(page);
  const a = all.find((i) => i.title === area)!;
  const proj = all.find((i) => i.title === "Scoring engine" && i.parentId === a.id)!;
  expect(proj.kind).toBe("project");
  expect(all.find((i) => i.title === "Cache warmup")).toMatchObject({ parentId: proj.id, kind: "thread" });

  // Area page: a container — projects with progress, no status/validation/packet.
  await row(page, area).locator("> div").click();
  const article = page.getByRole("article");
  await expect(article).toHaveAttribute("data-node-kind", "area");
  await expect(page.getByRole("heading", { level: 2, name: area })).toBeVisible();
  await expect(page.getByTestId("children-projects")).toContainText("Scoring engine");
  await expect(article.getByRole("button", { name: "+ Project" })).toBeVisible();
  await expect(article.getByText("Validation", { exact: true })).toHaveCount(0);
  await expect(article.getByText("Work packet")).toHaveCount(0);
  await expect(page.getByLabel("Status", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Project page: children + "+ Item"; inline add below the list.
  await page
    .getByTestId("children-projects")
    .getByRole("button", { name: /Scoring engine/ })
    .click();
  await expect(article).toHaveAttribute("data-node-kind", "project");
  await page.getByTestId("children-work").getByRole("button", { name: "Add item, sub-project or path" }).click();
  await page.getByLabel("New item in Scoring engine").fill("Load bench");
  await page.getByLabel("New item in Scoring engine").press("Enter");
  await expect(page.getByTestId("children-work")).toContainText("Load bench");
  await page.getByLabel("New item in Scoring engine").press("Escape");

  // Item page: one primary action + Chat here + ⋯ (no wall of buttons).
  await page
    .getByTestId("children-work")
    .getByRole("button", { name: /Cache warmup/ })
    .click();
  await expect(article).toHaveAttribute("data-node-kind", "work");
  const header = article.locator("section").first();
  await expect(header.getByRole("button", { name: "Start focused work" })).toBeVisible();
  for (const gone of ["Link PR", "Link URL", "New child", "Link conversation"]) await expect(header.getByRole("button", { name: gone })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Children/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Convert item → project (and the page becomes a container).
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Convert to project" }).click();
  await expect(article).toHaveAttribute("data-node-kind", "project");
  await expect.poll(async () => (await items(page)).find((i) => i.title === "Cache warmup")?.kind).toBe("project");
});

test("bulk select → Move to…, and file unfiled conversations in bulk", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const { item: area } = await post<{ item: Item }>(page, "/api/work/items/path", { path: [`Move area ${nonce}`, "Inbox zero", `One ${nonce}`] });
  const two = await post<{ item: Item }>(page, "/api/work/items/path", { path: [`Move area ${nonce}`, "Inbox zero", `Two ${nonce}`] });
  const target = await post<{ item: Item }>(page, "/api/work/items/path", { path: [`Move area ${nonce}`, `Target ${nonce}`], kind: "project" });
  void area;

  await page.goto("/areas?view=tree");
  await tree(page)
    .getByRole("treeitem", { name: new RegExp(`^One ${nonce},`) })
    .locator("> div")
    .click({ modifiers: ["Control"] });
  await tree(page)
    .getByRole("treeitem", { name: new RegExp(`^Two ${nonce},`) })
    .locator("> div")
    .click({ modifiers: ["Control"] });
  const bulk = page.getByRole("region", { name: "Selection" });
  await expect(bulk).toContainText("2 selected");
  await bulk.getByRole("button", { name: "Move to…" }).click();
  const picker = page.getByRole("dialog", { name: "Move 2 items" });
  await picker.getByRole("combobox", { name: "Search destinations" }).fill(`Target ${nonce}`);
  await picker.getByRole("combobox", { name: "Search destinations" }).press("Enter");
  await expect(picker).toHaveCount(0);
  await expect.poll(async () => (await items(page)).filter((i) => i.parentId === target.item.id).length).toBe(2);
  expect((await items(page)).find((i) => i.id === two.item.id)?.parentId).toBe(target.item.id);

  // Unfiled conversations: select two, file both with one picker.
  const s1 = await post<{ id: string }>(page, "/api/hermes/sessions", { title: `Bulk file one ${nonce}`, backend: "hermes" });
  const s2 = await post<{ id: string }>(page, "/api/hermes/sessions", { title: `Bulk file two ${nonce}`, backend: "hermes" });
  await page.goto("/areas?view=tree");
  const triage = page.locator("section[aria-labelledby=unfiled-triage]");
  await expect(triage.getByRole("heading", { name: /Unfiled conversations · \d+/ })).toBeVisible({ timeout: 20_000 });
  const showAll = triage.getByRole("button", { name: /Show all/ });
  if (await showAll.isVisible()) await showAll.click();
  await expect(triage.getByText(`Bulk file one ${nonce}`)).toBeVisible({ timeout: 20_000 });
  await triage.getByLabel(`Select Bulk file one ${nonce}`).check();
  await triage.getByLabel(`Select Bulk file two ${nonce}`).check();
  await page.getByRole("region", { name: "Selected conversations" }).getByRole("button", { name: "File to…" }).click();
  const fileDlg = page.getByRole("dialog", { name: "File 2 conversations" });
  await fileDlg.getByRole("combobox", { name: "Search destinations" }).fill(`Target ${nonce}`);
  await fileDlg.getByRole("option", { name: new RegExp(`Target ${nonce}`) }).click();
  await expect(fileDlg).toHaveCount(0);
  await expect
    .poll(async () => (await items(page)).filter((i) => i.parentId === target.item.id && i.kind === "conversation").length, { timeout: 15_000 })
    .toBe(2);
  expect(s1.id && s2.id).toBeTruthy();
});
