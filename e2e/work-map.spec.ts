import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Work from Jarvis batch 1: /map (area rollups → drill-down with filters) and
 * the Decisions inbox (answer → activity row + Undo). Titles use
 * Pelican/Marigold/Heron/Osprey/Gannet words no other spec uses.
 */

async function make(page: Page, body: Record<string, unknown>, patch?: Record<string, unknown>) {
  const r = await appPost(page, "/api/work/items", body);
  expect(r.ok(), await r.text()).toBeTruthy();
  const id = ((await r.json()) as { item: { id: string } }).item.id;
  if (patch) {
    const p = await page.request.patch(`/api/work/items/${id}`, { data: patch, headers: { "x-jarvis-csrf": "1" } });
    expect(p.ok(), await p.text()).toBeTruthy();
  }
  return id;
}

async function seed(page: Page, nonce: string) {
  const area = await make(page, { kind: "area", title: `Pelican wharf ${nonce}` });
  const project = await make(page, { kind: "project", title: `Marigold dock ${nonce}`, parentId: area });
  const heron = await make(page, { kind: "thread", title: `Heron ledger ${nonce}`, parentId: project }, { nextAction: "Count the crates", status: "ready" });
  const osprey = await make(page, { kind: "thread", title: `Osprey beacon ${nonce}`, parentId: project }, { tags: ["pelicanlight"] });
  const gannet = await make(
    page,
    { kind: "thread", title: `Gannet sail ${nonce}`, parentId: project },
    { decision: { question: `Gannet sail colour ${nonce}?`, choices: ["Teal", "Coral"] } },
  );
  return { area, project, heron, osprey, gannet };
}

test("map: area rollups, drill-down and filters", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const ids = await seed(page, nonce);
  await page.goto("/map");
  await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible();

  const card = page.getByTestId("map-area-card").filter({ hasText: `Pelican wharf ${nonce}` });
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 Blocked on you");
  await expect(card).toContainText("1 Next");
  await expect(card).toContainText("1 Backlog");

  // Tapping a card scopes the tree to that area.
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  const tree = page.getByTestId("map-tree");
  await expect(tree.locator("details.mp-area")).toHaveCount(1);
  // Projects start collapsed; open one to drill in.
  const heronRow = page.getByTestId("map-row").filter({ hasText: `Heron ledger ${nonce}` });
  await expect(heronRow).toBeHidden();
  await tree
    .locator("summary")
    .filter({ hasText: `Marigold dock ${nonce}` })
    .click();
  await expect(heronRow).toBeVisible();
  await expect(heronRow).toContainText("Next: Count the crates");

  // Search narrows (and opens the groups on the way).
  await page.getByLabel("Search the map").fill(`Osprey beacon ${nonce}`);
  await expect(page.getByTestId("map-row")).toHaveCount(1);
  await expect(page.getByTestId("map-row")).toContainText(`Osprey beacon ${nonce}`);
  await page.getByLabel("Search the map").fill("");

  // Status chip: only the item that waits on you.
  await page.getByLabel("Filter by status").selectOption("owner");
  await expect(page.getByTestId("map-row")).toHaveCount(1);
  await expect(page.getByTestId("map-row")).toContainText(`Gannet sail ${nonce}`);
  await expect(page.getByTestId("map-row")).toContainText("Needs you");

  // Tag chip.
  await page.getByLabel("Filter by status").selectOption("");
  await page.getByLabel("Filter by tag").selectOption("pelicanlight");
  await expect(page.getByTestId("map-row")).toHaveCount(1);
  await expect(page.getByTestId("map-row")).toContainText(`Osprey beacon ${nonce}`);
  await page.getByLabel("Filter by tag").selectOption("");

  // Inline status edit from a row.
  await page.getByLabel(`Status of Heron ledger ${nonce}`).selectOption("in_progress");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // Clean up the open decision so Today/other specs don't see it.
  const clear = await page.request.patch(`/api/work/items/${ids.gannet}`, { data: { decision: null }, headers: { "x-jarvis-csrf": "1" } });
  expect(clear.ok()).toBeTruthy();
});

test("decisions: answer with one tap → activity row + undo, then a typed answer", async ({ page }) => {
  const nonce = `d${Date.now().toString(36)}`;
  await page.goto("/home");
  const { gannet } = await seed(page, nonce);
  await page.goto("/decisions");
  await expect(page.getByRole("heading", { level: 1, name: "Needs you" })).toBeVisible();
  const question = `Gannet sail colour ${nonce}?`;
  const row = page.getByTestId("decision-row").filter({ hasText: question });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Coral" }).click();
  await expect(row).toBeHidden();
  const activity = async () =>
    ((await page.request.get(`/api/work/activity?item=${gannet}`).then((r) => r.json())) as { items: { detail: string | null }[] }).items;
  await expect.poll(async () => (await activity()).some((a) => a.detail === `Decision: ${question} → Coral`)).toBe(true);
  // The answer is appended to the item, status unchanged (never settles).
  const item = (await page.request.get(`/api/work/items/${gannet}`).then((r) => r.json())) as { item: { summary: string; status: string; decision: unknown } };
  expect(item.item.summary).toContain(`Decision: ${question} → Coral`);
  expect(item.item.decision).toBeNull();
  expect(item.item.status).toBe("captured");

  // Undo brings the question back.
  const bar = page.getByRole("status").filter({ hasText: "Saved" });
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(row).toBeVisible();

  // A typed answer works too.
  await row.getByLabel("Short answer").fill("Navy");
  await row.getByRole("button", { name: "Answer" }).click();
  await expect(row).toBeHidden();
  await expect.poll(async () => (await activity()).some((a) => a.detail === `Decision: ${question} → Navy`)).toBe(true);
});
