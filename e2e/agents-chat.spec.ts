import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow, mock, MOCK_URL } from "./helpers";

/**
 * Coordinators C1: Settings → Agents routes an area to its Hermes profile
 * (mock Hermes serves /p/momentumchief/ with its own key, set in the e2e
 * server env as JARVIS_HERMES_KEY_MOMENTUMCHIEF), the composer and area page
 * show who answers, and chat runs stream as AG-UI when that flag is on.
 */

async function putAgents(page: Page, body: unknown) {
  const r = await page.request.put("/api/settings/agents", { data: body, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

async function profileHits(page: Page) {
  const s = (await (await page.request.get(`${MOCK_URL}/__mock/state`)).json()) as { hermesProfileRequests?: Record<string, number> };
  return s.hermesProfileRequests?.momentumchief ?? 0;
}

async function routedArea(page: Page, title: string) {
  const r = await appPost(page, "/api/work/items", { kind: "area", title });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { item } = (await r.json()) as { item: { id: string } };
  const p = await page.request.patch(`/api/work/items/${item.id}`, { data: { settings: { agentMode: "momentumchief" } }, headers: { "x-jarvis-csrf": "1" } });
  expect(p.ok(), await p.text()).toBeTruthy();
  return item.id;
}

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});
test.afterEach(async ({ page }) => {
  await putAgents(page, { routing: false, aguiStream: false, routes: [] });
});

test("Settings → Agents: add a profile route, test it, turn routing on", async ({ page }) => {
  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await page.getByLabel("Hermes profile", { exact: true }).fill("momentumchief");
  await expect(page.getByLabel("Key env var")).toHaveAttribute("placeholder", "JARVIS_HERMES_KEY_MOMENTUMCHIEF");
  await page.getByRole("button", { name: "Save route" }).click();
  const row = page.getByTestId("agent-route-momentumchief");
  await expect(row).toContainText("Key set");
  await expect(row).toContainText("/p/momentumchief");
  await row.getByRole("button", { name: "Test momentumchief" }).click();
  await expect(row.getByRole("status")).toHaveText("Connected");
  await page.getByLabel(/Route areas to their Hermes profile/).check();
  await expect(page.getByText("Saved")).toBeVisible();
  // The key value itself is never in the page.
  await expect(page.locator("body")).not.toContainText("mock-hermes-momentumchief-key");
  await expectNoHorizontalOverflow(page);
});

test("a chat started under a routed area runs on its profile, streamed as AG-UI", async ({ page }) => {
  test.setTimeout(120_000);
  await putAgents(page, { routing: true, aguiStream: true, routes: [{ profile: "momentumchief", keyEnv: "JARVIS_HERMES_KEY_MOMENTUMCHIEF", baseUrl: null }] });
  const areaId = await routedArea(page, `Bets ${Date.now().toString(36)}`);
  await page.goto(`/areas?item=${areaId}`);
  const nodeChip = page.getByTestId("node-agent-chip");
  await expect(nodeChip).toContainText("momentumchief");
  await expect(nodeChip).toHaveAttribute("data-routed", "1");

  const before = await profileHits(page);
  await page.getByRole("button", { name: "Chat here" }).click();
  await page.waitForURL(/\/chat\/.+/);
  const chip = page.getByTestId("agent-chip");
  await expect(chip).toContainText("momentumchief");
  await expect(chip).toHaveAttribute("data-routed", "1");

  // Approval round trip over the AG-UI stream (interrupt → card → answer → next run).
  const composer = page.locator("#composer");
  await composer.fill("please delete the build folder");
  const started = page.waitForResponse((r) => /\/api\/hermes\/sessions\/[^/]+\/runs$/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const { runId } = (await (await started).json()) as { runId: string };
  const card = page.getByRole("group", { name: "Hermes needs your approval" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("rm -rf build");
  await card.getByRole("button", { name: "Approve once" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await profileHits(page)).toBeGreaterThan(before);

  // The relay really spoke AG-UI for this run.
  const sse = await (await page.request.get(`/api/hermes/runs/${runId}/events?format=agui`)).text();
  expect(sse).toContain('"type":"RUN_STARTED"');
  expect(sse).toContain('"type":"RUN_FINISHED"');
  expect(sse).not.toContain('"type":"text.delta"');
  await expectNoHorizontalOverflow(page);
});

test("a dropped AG-UI stream never shows a false completion; it reconciles", async ({ page }) => {
  await putAgents(page, { aguiStream: true });
  await page.goto("/home");
  await page.getByLabel("Capture or ask Hermes").fill("drop the connection midway");
  await page.getByRole("button", { name: "Ask Hermes", exact: true }).click();
  await page.waitForURL(/\/chat\/.+/);
  // Default profile: no agent chip without an area agent.
  await expect(page.getByTestId("agent-chip")).toHaveCount(0);
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Here's what I found/)).toBeVisible();
});

test("with routing off, an area's profile is only a hint (and says so)", async ({ page }) => {
  const areaId = await routedArea(page, `Hint ${Date.now().toString(36)}`);
  await page.goto(`/areas?item=${areaId}`);
  const nodeChip = page.getByTestId("node-agent-chip");
  await expect(nodeChip).toContainText("momentumchief (hint)");
  await expect(nodeChip).toHaveAttribute("data-routed", "0");
});
