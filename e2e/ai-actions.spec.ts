import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/**
 * Phase 5 AI task actions against the mock Hermes (JARVIS_AI_JOB answers):
 * Get started → Research → report with sources → next action; plan → child items;
 * Finance areas offer no AI actions.
 */

async function api<T = unknown>(page: Page, method: "get" | "post" | "put" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const r = await page.request[method](path, { data, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

type Item = { id: string; title: string };
const create = async (page: Page, body: Record<string, unknown>) => (await api<{ item: Item }>(page, "post", "/api/work/items", body)).item;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await api(page, "put", "/api/settings/ai", { enabled: true });
});
test.afterEach(async ({ page }) => {
  await api(page, "put", "/api/settings/ai", { enabled: false });
});

test("research an item: job chip, report viewer with sources, use a next action", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const area = await create(page, { kind: "area", title: `AI area ${nonce}` });
  const item = await create(page, { kind: "thread", title: `Pick a criteria engine ${nonce}`, parentId: area.id });
  await page.goto(`/areas?item=${item.id}`);
  const start = page.getByTestId("ai-get-started").getByRole("button", { name: /Get started/ });
  await expect(start).toBeVisible();
  await start.click();
  const sheet = page.getByRole("dialog", { name: "Research it" });
  await expect(sheet.getByText("Finance is never sent to AI.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await sheet.getByTestId("ai-start").click();
  await expect(sheet).toHaveCount(0);
  const row = page.getByTestId("ai-report-row").first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.click();
  const viewer = page.getByRole("dialog", { name: /Findings/ });
  await expect(viewer.getByRole("heading", { name: "Sources" })).toBeVisible();
  await expect(viewer.locator('a[rel="noopener noreferrer nofollow"][href^="https://example.com/option-a"]').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await viewer.getByRole("button", { name: "Use as next action" }).first().click();
  await expect(page.getByText(/Try option A for/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  // The research conversation is filed under the item.
  const detail = await api<{ links: { kind: string; role: string }[] }>(page, "get", `/api/work/items/${item.id}`);
  expect(detail.links.some((l) => l.kind === "chat_session" && l.role === "evidence")).toBe(true);
});

test("make a plan → create child items", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const area = await create(page, { kind: "area", title: `Plan area ${nonce}` });
  const item = await create(page, { kind: "thread", title: `Ship the evaluator ${nonce}`, parentId: area.id });
  await page.goto(`/areas?item=${item.id}`);
  await page.getByTestId("ai-get-started").getByRole("button", { name: "More AI actions" }).click();
  await page.getByRole("menuitem", { name: /Make a plan/ }).click();
  await page.getByRole("dialog", { name: "Make a plan" }).getByTestId("ai-start").click();
  const row = page.getByTestId("ai-report-row").first();
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.click();
  await page.getByRole("button", { name: "Create 3 child items" }).click();
  await expect.poll(async () => (await api<{ children: unknown[] }>(page, "get", `/api/work/items/${item.id}`)).children.length).toBe(3);
});

test("Finance areas offer no AI actions", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const fin = await create(page, { kind: "area", title: "Finance" });
  const item = await create(page, { kind: "thread", title: `Compare savings ${nonce}`, parentId: fin.id });
  await page.goto(`/areas?item=${item.id}`);
  await expect(page.getByRole("heading", { name: `Compare savings ${nonce}` })).toBeVisible();
  await expect(page.getByTestId("ai-get-started")).toHaveCount(0);
  const r = await page.request.post(`/api/work/items/${item.id}/ai-actions`, {
    data: { action: "research", clientKey: `e2e${nonce}` },
    headers: { "x-jarvis-csrf": "1" },
  });
  expect(r.status()).toBe(403);
  await api(page, "patch", `/api/work/items/${fin.id}`, { archived: true });
});
