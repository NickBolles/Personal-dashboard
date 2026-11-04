import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Agent access (docs/agent-tools.md): mint a scoped token in Settings → Agents (shown once),
 * call Jarvis MCP with it (create an item), see "by @agent" on the item and in Activity, undo it,
 * then revoke the token and see MCP refuse it. Words ("Spokeshave", "Drawknife") are unique to
 * this spec; names carry a nonce so retries/projects sharing the e2e DB don't collide.
 */

async function mcpCall(page: Page, token: string, name: string, args: Record<string, unknown>) {
  const res = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return res;
}

test("mint a token, MCP creates an item attributed to the agent, undo, revoke", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const profile = `e2e${nonce}`.slice(0, 30);
  await page.goto("/home");
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Spokeshave bench ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;

  // Signed-out / tokenless MCP is refused.
  expect((await page.request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "ping" } })).status()).toBe(401);

  await page.goto("/settings/agents");
  const card = page.getByTestId("agent-access");
  await card.getByLabel("Name").fill(`Drawknife ${nonce}`);
  await card.getByLabel("Hermes profile").fill(profile);
  await card.getByRole("button", { name: "Create token" }).click();
  const once = card.getByTestId("agent-token-once");
  await expect(once).toBeVisible();
  const token = await once.getByLabel(`Agent token for ${profile}`).inputValue();
  expect(token).toMatch(/^jva_/);
  await once.getByRole("button", { name: "Done" }).click();
  await expect(once).toHaveCount(0);
  const row = card.getByTestId("agent-token-row").filter({ hasText: `Drawknife ${nonce}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText(token.slice(-4));
  await expect(row).not.toContainText(token);

  // MCP create → item shows "created by @profile", Activity shows "by @profile" with Undo.
  const res = await mcpCall(page, token, "jarvis_create_item", { parentId: areaId, title: `Spokeshave tune-up ${nonce}`, nextAction: "Hone the blade" });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { result: { isError?: boolean; structuredContent: { item: { id: string } } } };
  expect(body.result.isError).toBeFalsy();
  const itemId = body.result.structuredContent.item.id;
  await page.goto(`/areas?item=${itemId}`);
  await expect(
    page
      .getByTestId("agent-chip")
      .filter({ hasText: `created by @${profile}` })
      .first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  const feed = page.getByRole("region", { name: "Activity" });
  const created = feed.locator(".jv-activity-row", { hasText: "created" });
  await expect(created.getByTestId("agent-chip")).toHaveText(`by @${profile}`);
  await created.getByRole("button", { name: /Undo/ }).click();
  await expect.poll(async () => (await page.request.get(`/api/work/items/${itemId}`)).status()).toBe(404);

  // Revoke (confirmed) → MCP refuses the token.
  await page.goto("/settings/agents");
  const row2 = page
    .getByTestId("agent-access")
    .getByTestId("agent-token-row")
    .filter({ hasText: `Drawknife ${nonce}` });
  await row2.getByRole("button", { name: `Revoke Drawknife ${nonce}` }).click();
  await row2.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row2).toContainText("Revoked");
  expect((await mcpCall(page, token, "jarvis_tree", {})).status()).toBe(401);
});
