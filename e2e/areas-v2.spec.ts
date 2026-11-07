import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Areas v2 (N6): the view tabs (Overview · Board · Activity · Graph) swap the
 * pane in place and keep the selected node; the Graph tab is a radial mind map
 * whose nodes re-centre it; /areas/map redirects there. Runs on phone (mobile)
 * and desktop. Titles use Quokka/Wombat/Bilby words no other spec uses.
 */

async function make(page: Page, body: Record<string, unknown>) {
  const r = await appPost(page, "/api/work/items", body);
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { item: { id: string } }).item.id;
}

async function seed(page: Page) {
  const nonce = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const area = await make(page, { kind: "area", title: `Quokka range ${nonce}` });
  const project = await make(page, { kind: "project", title: `Wombat burrow ${nonce}`, parentId: area });
  const item = await make(page, { kind: "thread", title: `Bilby lantern ${nonce}`, parentId: project });
  const other = await make(page, { kind: "thread", title: `Bilby compass ${nonce}`, parentId: project });
  return { nonce, area, project, item, other };
}

const views = (page: Page) => page.getByRole("tablist", { name: "Views" });
const tab = (page: Page, name: string) => views(page).getByRole("tab", { name, exact: true });

test("view tabs keep the selected node and stay in the same spot", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas?item=${s.project}`);
  await expect(page.getByRole("heading", { level: 2, name: `Wombat burrow ${s.nonce}` })).toBeVisible();
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  const top = async () => (await views(page).boundingBox())!.y;
  const y0 = await top();

  await tab(page, "Board").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=board$`));
  await expect(tab(page, "Board")).toHaveAttribute("aria-selected", "true");
  // The node stays named above the pane, and the board is scoped to it.
  await expect(page.getByTestId("node-header")).toContainText(`Wombat burrow ${s.nonce}`);
  await expect(page.getByTestId("map-row").filter({ hasText: `Bilby lantern ${s.nonce}` })).toBeVisible();
  expect(Math.abs((await top()) - y0)).toBeLessThan(2);

  await tab(page, "Activity").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=activity$`));
  await expect(page.getByTestId("node-header")).toContainText(`Wombat burrow ${s.nonce}`);

  await tab(page, "Graph").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=graph$`));
  await expect(page.getByTestId("radial-graph").locator(`[data-node-id="${s.project}"][data-centre="true"]`)).toBeVisible();
  expect(Math.abs((await top()) - y0)).toBeLessThan(2);

  // Reload keeps both (URL state), then back to Overview.
  await page.reload();
  await expect(tab(page, "Graph")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Overview").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}$`));
  await expect(page.getByRole("heading", { level: 2, name: `Wombat burrow ${s.nonce}` })).toBeVisible();

  // Keyboard: arrows move between tabs (automatic activation).
  await tab(page, "Overview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Board")).toBeFocused();
  await expect(page).toHaveURL(/tab=board/);

  // A work item folds its Chats section into the same bar.
  await page.goto(`/areas?item=${s.item}&tab=activity`);
  await expect(tab(page, "Chats")).toBeVisible();
  await expect(tab(page, "Activity")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 2, name: `Bilby lantern ${s.nonce}` })).toBeVisible();
});

test("graph: tap a node to re-centre, breadcrumb back out, list fallback", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas?item=${s.area}&tab=graph`);
  const graph = page.getByTestId("radial-graph");
  await expect(graph.locator(`[data-node-id="${s.area}"][data-centre="true"]`)).toBeVisible();
  await graph.locator(`[data-node-id="${s.project}"]`).click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=graph$`));
  await expect(graph.locator(`[data-node-id="${s.project}"][data-centre="true"]`)).toBeVisible();
  await expect(graph.locator(`[data-node-id="${s.item}"][data-ring="1"]`)).toBeVisible();

  // Keyboard: Enter on a focused node re-centres too.
  await graph.locator(`[data-node-id="${s.item}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`item=${s.item}&tab=graph$`));

  // Breadcrumb walks back up without leaving the Graph.
  await page
    .getByRole("navigation", { name: "Graph breadcrumb" })
    .getByRole("button", { name: `Quokka range ${s.nonce}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`item=${s.area}&tab=graph$`));

  // List fallback (screen readers, 200% zoom): the same nodes as buttons.
  await page.getByRole("button", { name: "Show as list" }).click();
  await page
    .getByTestId("graph-tab")
    .getByRole("button", { name: new RegExp(`^Wombat burrow ${s.nonce}`) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=graph$`));
});

test("/areas/map redirects to the Graph tab and keeps the query", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas/map?root=${s.project}&from=bookmark`);
  await expect(page).toHaveURL(new RegExp(`/areas\\?item=${s.project}&tab=graph&from=bookmark$`));
  await expect(page.getByTestId("graph-tab")).toBeVisible();
  await page.goto("/areas/map");
  await expect(page).toHaveURL(/\/areas\?tab=graph$/);
  await expect(page.getByTestId("radial-graph")).toBeVisible();
});

test("desktop: picking a tree row keeps the open tab", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "the side tree is beside the page on desktop only");
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas?item=${s.item}&tab=graph`);
  await expect(page.getByTestId("radial-graph")).toBeVisible();
  await page.locator(`#work-tree [data-row-id="${s.other}"]`).click();
  await expect(page).toHaveURL(new RegExp(`item=${s.other}&tab=graph$`));
  await expect(page.getByTestId("radial-graph").locator(`[data-node-id="${s.other}"][data-centre="true"]`)).toBeVisible();
});

test("phone overview: areas, needs you, in progress, outstanding", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("desktop"), "phone layout");
  await page.goto("/home");
  const s = await seed(page);
  const p = await page.request.patch(`/api/work/items/${s.item}`, { data: { status: "in_progress" }, headers: { "x-jarvis-csrf": "1" } });
  expect(p.ok()).toBeTruthy();
  await page.goto("/areas");
  const order = await page.evaluate(() =>
    ["map-overview", "map-needs-you-h", "digest-inflight", "digest-outstanding"].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`) ?? document.getElementById(id);
      return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1;
    }),
  );
  // Needs you may be empty (no section) — the rest must be in this order.
  const shown = order.filter((y) => y >= 0);
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
  await expect(page.getByTestId("digest-inflight")).toContainText(`Bilby lantern ${s.nonce}`);
});
