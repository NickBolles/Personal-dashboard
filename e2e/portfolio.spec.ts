import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * Phase 4 lane 3: the Portfolio tab on the Areas landing replaces the published
 * portfolio map. Projects show their open work in status lanes; the map JSON
 * imports with a dry-run preview, one Undo, and no duplicates on a re-run.
 * Titles use Numbat/Quoll words no other spec uses.
 */

async function make(page: Page, body: Record<string, unknown>) {
  const r = await appPost(page, "/api/work/items", body);
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { item: { id: string } }).item.id;
}

/**
 * The importer files unknown board projects under the Portfolio area: make sure one exists.
 * Returns the id when THIS spec created it, so the test can archive it again: a live area
 * titled "Portfolio" becomes the global coordinator (server/work/coordinator.ts), which adds
 * the coordinator tray/rail chip to every later spec sharing this server.
 */
async function ensurePortfolioArea(page: Page): Promise<string | null> {
  const r = await page.request.get("/api/work/items");
  const { items } = (await r.json()) as { items: { id: string; title: string; parentId: string | null; archived: boolean }[] };
  const found = items.find((i) => i.parentId === null && !i.archived && i.title.toLowerCase() === "portfolio");
  return found ? null : await make(page, { kind: "area", title: "Portfolio" });
}

/**
 * Everything this spec creates is archived again (leaf first): specs share one server/DB, and a live
 * in-progress "Numbat lantern" grew the work dashboard's Priorities widget (work.spec drag target
 * slid under the phone tray) and the "Numbat range <nonce>" area card overflowed /areas at 320 px / 200 % text.
 */
let cleanup: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of cleanup.reverse()) {
    const r = await page.request.patch(`/api/work/items/${id}`, { data: { archived: true }, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  cleanup = [];
});

const views = (page: Page) => page.getByRole("tablist", { name: "Views" });

test("portfolio tab: project lanes, then import a map with preview, undo and no duplicates", async ({ page }) => {
  await page.goto("/home");
  const nonce = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const portfolio = await ensurePortfolioArea(page);
  if (portfolio) cleanup.push(portfolio);
  const area = await make(page, { kind: "area", title: `Numbat range ${nonce}` });
  cleanup.push(area);
  const project = await make(page, { kind: "project", title: `Numbat warren ${nonce}`, parentId: area });
  cleanup.push(project);
  const item = await make(page, { kind: "thread", title: `Numbat lantern ${nonce}`, parentId: project });
  cleanup.push(item);
  const r = await page.request.patch(`/api/work/items/${item}`, {
    data: { status: "in_progress", nextAction: "Trim the wick" },
    headers: { "x-jarvis-csrf": "1" },
  });
  expect(r.ok(), await r.text()).toBeTruthy();

  await page.goto("/areas");
  await views(page).getByRole("tab", { name: "Portfolio", exact: true }).click();
  await expect(page).toHaveURL(/tab=portfolio/);
  const root = page.getByTestId("portfolio");
  const row = root.getByTestId("portfolio-row").filter({ hasText: `Numbat warren ${nonce}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`Numbat range ${nonce}`);
  await expect(row.locator(".pf-lane").filter({ hasText: "In flight" })).toContainText(`Numbat lantern ${nonce}`);

  // Import: paste → Preview (dry run, nothing written) → Import → Undo.
  const map = {
    projects: [{ id: `quoll-${nonce}`, name: `Quoll garden ${nonce}`, links: [["Board", "https://artifacts.ai.nickbolles.com/v/quoll-board/"]] }],
    nodes: [
      {
        p: `quoll-${nonce}`,
        g: "Beds (spring)",
        t: `Quoll seedlings ${nonce} (LIVE)`,
        s: "inflight",
        sum: "Water daily. Then thin.",
        l: [["#7", "https://github.com/NickBolles/Personal-dashboard/pull/7"]],
      },
      { p: `quoll-${nonce}`, g: "Beds (spring)", t: `Quoll fence ${nonce}`, s: "owner", sum: "Pick a height." },
    ],
    ownerBlocked: [],
  };
  const importOnce = async () => {
    await root.getByRole("button", { name: "Import map JSON" }).click();
    const dialog = page.getByRole("dialog", { name: "Import portfolio map" });
    await dialog.getByLabel("Or paste the JSON").fill(JSON.stringify(map));
    await dialog.getByRole("button", { name: "Preview" }).click();
    return dialog;
  };
  let dialog = await importOnce();
  const preview = dialog.getByTestId("import-preview");
  await expect(preview).toContainText("3 new");
  await expect(preview).toContainText(`Quoll seedlings ${nonce}`);
  await expect(root.getByTestId("portfolio-row").filter({ hasText: `Quoll garden ${nonce}` })).toHaveCount(0);
  await dialog.getByRole("button", { name: /^Import 3 new/ }).click();
  await expect(dialog).toBeHidden();
  const imported = root.getByTestId("portfolio-row").filter({ hasText: `Quoll garden ${nonce}` });
  await expect(imported).toBeVisible();
  await expect(imported.locator(".pf-lane").filter({ hasText: "In flight" })).toContainText(`Quoll seedlings ${nonce}`);
  await expect(imported.locator(".pf-lane").filter({ hasText: "Blocked on you" })).toContainText(`Quoll fence ${nonce}`);
  await expect(imported.getByRole("link", { name: /PR #7/ })).toBeVisible();

  await page.getByRole("status").filter({ hasText: "Imported portfolio map" }).getByRole("button", { name: "Undo" }).click();
  await expect(imported).toHaveCount(0);

  // Import for real, then a second preview finds nothing new.
  dialog = await importOnce();
  await dialog.getByRole("button", { name: /^Import 3 new/ }).click();
  await expect(dialog).toBeHidden();
  await expect(imported).toBeVisible();
  dialog = await importOnce();
  await expect(dialog.getByTestId("import-preview")).toContainText("0 new");
  await expect(dialog.getByTestId("import-preview")).toContainText("Everything on the board is already in Jarvis.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // The decision shows in Needs you on the same page; the tab is landing-only.
  await expect(root.getByTestId("needs-you")).toContainText(`Quoll fence ${nonce}`);
  await expectNoHorizontalOverflow(page);
  await page.goto(`/areas?item=${project}&tab=portfolio`);
  await expect(views(page).getByRole("tab", { name: "Portfolio", exact: true })).toHaveCount(0);
  await expect(views(page).getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
});
