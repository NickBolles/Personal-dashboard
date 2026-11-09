import { expect, test, type Locator, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * Coordinator workflow v3 (CW, PR 2): decisions raised over MCP show in Needs you and are answered in
 * two taps from the tray (low risk) or behind a Confirm (risk-flagged); run notices fold into the run;
 * the coordinator chat opens with one "Since HH:MM" divider. The file name matches the desktop project's
 * `global-coordinator.spec.ts` pattern, so it runs on phone and desktop: every title carries a nonce with
 * the project name, the area is archived and the token revoked afterwards. Words ("Quillwort", "Sedge")
 * are unique to this spec.
 */

type Minted = { token: string; view: { id: string } };

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

async function decisionState(page: Page, ref: string) {
  const res = await page.request.get("/api/coordinator/decisions?state=all");
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { decisions: { ref: string; state: string; answeredChoice: string | null }[] };
  return body.decisions.find((d) => d.ref === ref);
}

/** Opens Needs you: the tray's "!N" count on phones, the rail tab on desktop. Returns the panel scope. */
async function openNeeds(page: Page, desktop: boolean): Promise<Locator> {
  if (desktop) {
    const rail = page.getByRole("complementary", { name: "Chief of staff" });
    await rail.getByRole("tab", { name: /^Needs you/ }).click();
    return rail;
  }
  await page
    .locator(".gc-tray")
    .getByRole("button", { name: /need you, open Needs you$/ })
    .click();
  return page.getByRole("dialog", { name: "Chief of staff" });
}

let areaId: string | null = null;
let minted: Minted | null = null;
test.afterEach(async ({ page }) => {
  if (minted) await page.request.delete(`/api/settings/agents/tokens/${minted.view.id}`, { headers: { "x-jarvis-csrf": "1" } });
  if (areaId) await page.request.patch(`/api/work/items/${areaId}`, { data: { archived: true }, headers: { "x-jarvis-csrf": "1" } });
  minted = null;
  areaId = null;
});

test("MCP-raised decisions: tray → answer in 2 taps with Undo; risk-flagged needs Confirm", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const nonce = `${Date.now().toString(36)}${info.retry}${info.project.name.replace(/\W/g, "")}`;
  await page.goto("/home");
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Quillwort bench ${nonce}` });
  expect(a.ok(), await a.text()).toBeTruthy();
  areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const it = await appPost(page, "/api/work/items", { kind: "thread", title: `Sedge ledger ${nonce}`, parentId: areaId });
  const itemId = ((await it.json()) as { item: { id: string } }).item.id;
  const m = await appPost(page, "/api/settings/agents/tokens", {
    name: `Quillwort ${nonce}`,
    profile: `cw${nonce}`.slice(0, 30),
    scopes: ["work.read", "decisions.write"],
  });
  expect(m.ok(), await m.text()).toBeTruthy();
  minted = (await m.json()) as Minted;

  const low = (await mcpCall(page, minted.token, "jarvis_raise_decision", {
    itemId,
    question: `Ship the sedge ledger ${nonce}?`,
    choices: ["Ship it", "Wait"],
    recommended: "Ship it",
    pack: { why: "The ledger passed review." },
  })) as { ref: string };
  const risky = (await mcpCall(page, minted.token, "jarvis_raise_decision", {
    itemId,
    question: `Rotate the quillwort key ${nonce}?`,
    choices: ["Rotate", "Keep"],
    recommended: "Rotate",
    risk: ["credential"],
  })) as { ref: string };
  expect(low.ref).toMatch(/^D-\d+$/);

  await page.goto("/home");
  // Tap 1: the tray count (phone) / the rail tab (desktop). Tap 2: the recommended answer on the row.
  const scope = await openNeeds(page, desktop);
  await scope.getByRole("button", { name: `${low.ref}: Ship it`, exact: true }).click();
  await expect(scope.getByRole("button", { name: "Undo" }).first()).toBeVisible();
  await expect.poll(async () => (await decisionState(page, low.ref))?.state).toBe("answered");

  // Risk-flagged: the chip opens the detail with Confirm armed; nothing is answered until Confirm.
  await scope.getByRole("button", { name: `${risky.ref}: Rotate`, exact: true }).click();
  const confirm = scope.getByRole("group", { name: "Confirm answer" });
  await expect(confirm).toContainText("Confirm Rotate?");
  expect((await decisionState(page, risky.ref))?.state).toBe("open");
  await confirm.getByRole("button", { name: "Confirm Rotate", exact: true }).click();
  await expect.poll(async () => (await decisionState(page, risky.ref))?.answeredChoice).toBe("Rotate");
  await expectNoHorizontalOverflow(page);
});

/** Fully stubbed coordinator chat: one Hermes thread, a run with folded notices, a 2-hour-old chat look. */
async function stubCoordinatorChat(page: Page) {
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const session = { id: "cw-gc", title: "Portfolio coordinator", pinned: false, archived: false };
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: session.id,
        sessionTitle: session.title,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route("**/api/work/decisions*", (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/work/activity**", (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/work/items*", (route) => route.fulfill({ json: { items: [], linkedConversations: [] } }));
  await page.route("**/api/coordinator/decisions*", (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  const run = {
    id: "run-sedge",
    ref: "R-7",
    seq: 7,
    itemId: "item-sedge",
    itemTitle: "Sedge ledger",
    profile: "devchief",
    title: "Sedge ledger build",
    state: "running",
    stalled: false,
    summary: "Building",
    prUrl: null,
    parentRunId: null,
    parentRef: null,
    pipeline: [],
    lock: null,
    interruptedAt: null,
    startedAt: iso(50),
    updatedAt: iso(5),
    finishedAt: null,
    noticeCount: 2,
  };
  const notice = (id: string, minAgo: number) => ({
    id,
    runId: run.id,
    runRef: "R-7",
    type: "notice",
    summary: "Background process finished",
    payload: {},
    via: "agent:devchief",
    at: iso(minAgo),
  });
  await page.route("**/api/coordinator/runs", (route) =>
    route.fulfill({
      json: {
        runs: [run],
        events: [notice("e1", 20), notice("e2", 10)],
        lastLooked: { chat: iso(120), needs: null, running: null, changes: null, context: null },
      },
    }),
  );
  await page.route("**/api/coordinator/looked", (route) =>
    route.fulfill({ json: { lastLooked: { chat: new Date().toISOString(), needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/hermes/sessions**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ status: 409, json: { error: "Sending is not part of this test" } });
    if (path.endsWith("/area")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/execution"))
      return route.fulfill({ json: { sessionId: session.id, parent: null, records: [], sources: [{ source: "transcript", state: "ok" }], fetchedAt: iso(0) } });
    if (path.endsWith("/files") || path.endsWith("/links-panel")) return route.fulfill({ json: { files: [], links: [] } });
    if (path === "/api/hermes/sessions") return route.fulfill({ json: { sessions: [session], nextOffset: null } });
    return route.fulfill({
      json: {
        session,
        children: [],
        links: [],
        timeline: [
          { kind: "user", id: "u1", text: "Plan the sedge ledger", at: iso(180) },
          { kind: "assistant", id: "a1", text: "Started R-7 for the ledger.", at: iso(175) },
          { kind: "assistant", id: "a2", text: "R-7 is building; waiting on D-48 for the key.", at: iso(15) },
        ],
      },
    });
  });
}

test("coordinator chat: one Since divider after 2 h away, D-n/R-n chips, run notices fold into the run", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await stubCoordinatorChat(page);
  await page.goto("/more");
  const scope = desktop ? page.getByRole("complementary", { name: "Chief of staff" }) : page.getByRole("dialog", { name: "Chief of staff" });
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await scope.getByRole("tab", { name: "Chat", exact: true }).click();
  const divider = scope.getByRole("separator", { name: /^Since / });
  await expect(divider).toHaveCount(1);
  await expect(divider).toContainText("2 h");
  // The mention chip opens the run in Running.
  await scope.getByRole("button", { name: "Run R 7", exact: true }).last().click();
  await expect(scope.getByRole("tab", { name: /^Running/ })).toHaveAttribute("aria-selected", "true");
  await expect(scope.getByText("Sedge ledger build")).toBeVisible();
  await expect(scope.getByText(/2 notices/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
