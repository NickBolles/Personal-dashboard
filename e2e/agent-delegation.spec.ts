import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Delegated runs on items (docs/agent-tools.md "Delegations"): a coordinator registers a
 * delegation through Jarvis MCP (jarvis_run_start/update) and it shows on the item's Agent
 * panel (child summaries, copyable transcript path) and the Agents strip. With the browser
 * clock moved past the stall window the run reads "Stalled" (nothing is changed server-side).
 * Words ("Mortise", "Tenon gauge") are unique to this spec; names carry a nonce and the token
 * is revoked in finally, so retries/projects sharing the e2e DB stay independent.
 */

async function mcpCall(page: Page, token: string, name: string, args: Record<string, unknown>) {
  const res = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  expect(body.result.isError, JSON.stringify(body.result)).toBeFalsy();
  return body.result.structuredContent;
}

test("a delegation registered over MCP shows on the item and goes Stalled after the window", async ({ page }) => {
  const nonce = `${Date.now().toString(36)}${test.info().retry}${test.info().project.name.length}`;
  const profile = `dlg${nonce}`.slice(0, 30);
  await page.goto("/home");
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Mortise bench ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const it = await appPost(page, "/api/work/items", { kind: "thread", title: `Tenon gauge ${nonce}`, parentId: areaId });
  expect(it.ok(), await it.text()).toBeTruthy();
  const itemId = ((await it.json()) as { item: { id: string } }).item.id;

  const m = await appPost(page, "/api/settings/agents/tokens", { name: `Mortise ${nonce}`, profile, scopes: ["work.read", "runs.write"] });
  expect(m.ok(), await m.text()).toBeTruthy();
  const minted = (await m.json()) as { token: string; view: { id: string } };
  try {
    const transcript = `/opt/data/delegations/${nonce}/transcript.md`;
    const start = await mcpCall(page, minted.token, "jarvis_run_start", {
      itemId,
      title: `Cut the mortise ${nonce}`,
      delegationId: `deleg_${nonce}`,
      transcriptPath: transcript,
    });
    const runId = start.runId as string;
    await mcpCall(page, minted.token, "jarvis_run_update", {
      runId,
      state: "running",
      summary: "Two of three sub-agents done",
      children: [
        { title: "Chisel sizes", state: "done", summary: "3/8 inch fits" },
        { title: "Layout lines", state: "running" },
      ],
    });

    await page.goto(`/areas?item=${itemId}`);
    const panel = page.getByTestId("item-agent-panel");
    const run = panel.getByTestId("agent-run").filter({ hasText: `Cut the mortise ${nonce}` });
    await expect(run).toBeVisible();
    // One row per run in the item's Work list, in the shared state words ("Working", never "Running").
    await expect(run.getByTestId("agent-live")).toHaveText("Working");
    await expect(run.getByTestId("agent-stalled")).toHaveCount(0);
    // The row opens in place for its sub-agents and the ids to copy.
    await run.getByRole("button", { expanded: false }).click();
    await expect(run.getByTestId("agent-run-children")).toContainText("3/8 inch fits");
    await expect(run.getByTestId("agent-run-copy").filter({ hasText: transcript })).toBeVisible();
    await expect(run.getByRole("button", { name: "Copy transcript" })).toBeVisible();

    // 45 minutes later (browser clock only): Stalled on the panel and on the Agents strip.
    await page.clock.setFixedTime(new Date(Date.now() + 45 * 60_000));
    await page.reload();
    await expect(
      panel
        .getByTestId("agent-run")
        .filter({ hasText: `Cut the mortise ${nonce}` })
        .getByTestId("agent-stalled"),
    ).toHaveText("Stalled");
    await page.goto("/areas");
    const strip = page.getByTestId("agents-strip-row").filter({ hasText: `Tenon gauge ${nonce}` });
    await expect(strip.getByTestId("agent-stalled")).toBeVisible();
  } finally {
    await page.request.delete(`/api/settings/agents/tokens/${minted.view.id}`, { headers: { "x-jarvis-csrf": "1" } });
  }
});

test("an archived area still shows its projects with Show archived on (#183)", async ({ page }) => {
  const nonce = `${Date.now().toString(36)}${test.info().retry}`;
  await page.goto("/home");
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Dovetail shelf ${nonce}` });
  const areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const p = await appPost(page, "/api/work/items", { kind: "project", title: `Pin board ${nonce}`, parentId: areaId });
  expect(p.ok(), await p.text()).toBeTruthy();
  const arch = await page.request.patch(`/api/work/items/${areaId}`, { data: { archived: true }, headers: { "x-jarvis-csrf": "1" } });
  expect(arch.ok(), await arch.text()).toBeTruthy();
  await page.addInitScript(() => sessionStorage.setItem("jarvis:areas:show-archived", "1"));
  await page.goto(`/areas?item=${areaId}`);
  await expect(page.getByText(`Pin board ${nonce}`).first()).toBeVisible();
});
