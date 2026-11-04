import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";
import { coordinatorDemo } from "./fixtures/agents-demo";

// Unique vocabulary: Quasarling / Nebulark / Pulsarlet. No real Hermes request may escape.
async function stubCoordinator(page: Page, areaId: string, title: string) {
  await page.route("**/api/hermes/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/runs")) return route.fulfill({ json: { runId: "qa-stub-run", status: "completed" } });
    if (path.endsWith("/sessions") && route.request().method() === "POST") return route.fulfill({ json: { id: "qa-stub-session", title, activeRun: null } });
    if (path.includes("/sessions/")) return route.fulfill({ json: { session: { id: "qa-stub-session", title, activeRun: null }, timeline: [] } });
    return route.fulfill({ json: { sessions: [], complete: true } });
  });
  await page.route(/\/api\/work\/items\/[^/]+\/coordinator(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ...coordinatorDemo, area: { id: areaId, title }, sessionId: null } }),
  );
}
async function openPane(page: Page, title: string) {
  await page.goto("/areas");
  const card = page.getByTestId("map-area-card").filter({ hasText: title });
  await page.getByRole("listitem").filter({ has: card }).getByTestId("coordinator-open").click();
  return page.getByTestId("coordinator-pane");
}
async function makeArea(page: Page, title: string) {
  const response = await appPost(page, "/api/work/items", { kind: "area", title });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).item.id as string;
}

test("Quasarling chip fills only; explicit Send posts the run", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const title = `Quasarling observatory ${nonce}`;
  // Install the broad guard before any app navigation.
  await stubCoordinator(page, "pending", title);
  await page.goto("/home");
  const area = await makeArea(page, title);
  await stubCoordinator(page, area, title);
  const label = `Quasarling beacon ${nonce}`;
  const prompt = `Inspect Quasarling signals ${nonce}`;
  const made = await appPost(page, "/api/quick-actions", { label, prompt, scope: `area:${area}` });
  expect(made.ok()).toBeTruthy();
  const runs: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/hermes\/sessions\/[^/]+\/runs$/.test(new URL(r.url()).pathname)) runs.push(r.url());
  });
  const pane = await openPane(page, title);
  await pane.getByTestId("quick-actions-row").getByRole("button", { name: label, exact: true }).click();
  await expect(pane.getByTestId("coordinator-input")).toHaveValue(prompt);
  expect(runs).toEqual([]);
  await pane.getByTestId("coordinator-send").click();
  await expect.poll(() => runs.length).toBe(1);
  await expect(pane.getByTestId("coordinator-input")).toHaveValue("");
});

test("Nebulark MCP proposal needs Add and Undo removes the active chip", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const title = `Nebulark observatory ${nonce}`;
  await stubCoordinator(page, "pending", title);
  await page.goto("/home");
  const area = await makeArea(page, title);
  await stubCoordinator(page, area, title);
  const minted = await appPost(page, "/api/settings/agents/tokens", { name: `Nebulark ${nonce}`, profile: `qa${nonce}`.slice(0, 30), scopes: ["work.write"] });
  expect(minted.ok()).toBeTruthy();
  const { token, view } = await minted.json();
  const label = `Nebulark prism ${nonce}`;
  try {
    const proposed = await page.request.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}` },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jarvis_add_quick_action", arguments: { label, prompt: `Inspect Nebulark ${nonce}`, scope: `area:${area}` } },
      },
    });
    expect(proposed.ok()).toBeTruthy();
    const body = await proposed.json();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.proposed).toBe(true);
    const pane = await openPane(page, title);
    const card = pane.getByTestId("quick-action-proposal").filter({ hasText: label });
    await expect(card).toContainText("Add quick action?");
    await expect(pane.getByTestId("quick-actions-row").getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await expect(pane.getByTestId("quick-actions-row").getByRole("button", { name: label, exact: true })).toBeVisible();
    await page.getByRole("status").filter({ hasText: "Added ·" }).getByRole("button", { name: "Undo", exact: true }).click();
    await expect(pane.getByTestId("quick-actions-row").getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(card).toBeVisible();
  } finally {
    const revoked = await page.request.delete(`/api/settings/agents/tokens/${view.id}`, { headers: { "x-jarvis-csrf": "1" } });
    expect(revoked.ok()).toBeTruthy();
  }
});

test("Pulsarlet Manage reorder and delete persist after reload", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const title = `Pulsarlet observatory ${nonce}`;
  await stubCoordinator(page, "pending", title);
  await page.goto("/home");
  const area = await makeArea(page, title);
  await stubCoordinator(page, area, title);
  const first = `Pulsarlet amber ${nonce}`;
  const second = `Pulsarlet violet ${nonce}`;
  for (const label of [first, second]) expect((await appPost(page, "/api/quick-actions", { label, prompt: label, scope: `area:${area}` })).ok()).toBeTruthy();
  let pane = await openPane(page, title);
  await pane.getByTestId("quick-actions-row").getByRole("button", { name: "Manage quick actions", exact: true }).click();
  let manage = page.getByRole("dialog", { name: "Manage quick actions", exact: true });
  await manage.getByRole("button", { name: `Move up ${second}`, exact: true }).click();
  await expect
    .poll(async () => {
      const rows = (await (await page.request.get("/api/quick-actions")).json()).actions as { label: string; status: string }[];
      return rows.filter((r) => [first, second].includes(r.label) && r.status === "active").map((r) => r.label);
    })
    .toEqual([second, first]);
  await page.reload();
  pane = await openPane(page, title);
  await pane.getByTestId("quick-actions-row").getByRole("button", { name: "Manage quick actions", exact: true }).click();
  manage = page.getByRole("dialog", { name: "Manage quick actions", exact: true });
  const labels = await manage.getByTestId("quick-action-row").allTextContents();
  expect(labels.findIndex((s) => s.includes(second))).toBeLessThan(labels.findIndex((s) => s.includes(first)));
  await manage.getByRole("button", { name: `Delete ${second}`, exact: true }).click();
  await expect(manage.getByTestId("quick-action-row").filter({ hasText: second })).toHaveCount(0);
  await page.reload();
  pane = await openPane(page, title);
  await expect(pane.getByTestId("quick-actions-row").getByRole("button", { name: second, exact: true })).toHaveCount(0);
  await expect(pane.getByTestId("quick-actions-row").getByRole("button", { name: first, exact: true })).toBeVisible();
});
