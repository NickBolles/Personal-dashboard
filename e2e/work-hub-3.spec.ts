import crypto from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow, MOCK_URL } from "./helpers";

/**
 * Work hub phase 3 (docs/work.md): Today as the front door, the inbox
 * (captures + assigned GitHub issues from the mock GitHub), Settings →
 * Connections → GitHub, the read-only webhook, and the command dock.
 */

const READONLY_TOKEN = "github_pat_mock_readonly_momentum_0002";
const CLASSIC_TOKEN = "ghp_mock_classic_writer_token_0003";

async function api<T = unknown>(page: Page, method: "get" | "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const r = await page.request[method](path, { data, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

/** Remove GitHub connections so later specs see the same world as before (and the poller stops). */
async function removeConnections(page: Page) {
  const s = await api<{ connections: { id: string }[] }>(page, "get", "/api/github");
  for (const c of s.connections) await api(page, "delete", `/api/github/connections/${c.id}`);
}

/** The action map's petals (the menu itself is a zero-size anchor, so look for a petal). */
function actionMap(page: Page) {
  return page.locator('#command-map [data-petal="search"]');
}

function orb(page: Page) {
  return page.locator('[data-testid="dock-orb"]:visible');
}
/** Orb tap → radial menu → Search → palette. */
async function openPalette(page: Page) {
  await expect(async () => {
    if (!(await actionMap(page).count())) await orb(page).click();
    await actionMap(page).click();
    await expect(page.getByRole("combobox", { name: "Search Jarvis" })).toBeFocused({ timeout: 1000 });
  }).toPass();
}
async function centre(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test("work opens on Today; capture to the inbox, file it, no sideways scrolling", async ({ page }) => {
  await page.goto("/areas");
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Work at a glance" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Areas sections" }).getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect(page).not.toHaveURL(/item=/);
  await expectNoHorizontalOverflow(page);

  const nonce = Date.now().toString(36);
  await page
    .getByRole("navigation", { name: "Areas sections" })
    .getByRole("button", { name: /^Inbox/ })
    .click();
  await expect(page).toHaveURL(/view=inbox/);
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await page.getByLabel("Capture to inbox").fill(`Call the HVAC company ${nonce}\nAsk about filters`);
  await page.getByRole("button", { name: "Capture", exact: true }).last().click();
  const row = page.locator("[data-inbox-entry]", { hasText: `Call the HVAC company ${nonce}` });
  await expect(row).toContainText("Why: You captured it");
  await expectNoHorizontalOverflow(page);
  await row.getByRole("button", { name: `File: Call the HVAC company ${nonce}` }).click();
  const dialog = page.getByRole("dialog", { name: "File capture" });
  await expect(dialog.getByLabel("File under")).toHaveValue(/.+/); // Miscellaneous preselected
  await dialog.getByRole("button", { name: "File", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: `Call the HVAC company ${nonce}` })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Miscellaneous");
  // Miscellaneous defaults to "validation optional": the packet form preselects it.
  await page.getByRole("button", { name: "Start focused work" }).click();
  await expect(page.getByRole("dialog").getByLabel("Validation required before settling")).not.toBeChecked();
  await expect(page.getByRole("dialog").getByLabel("Why no validation is needed")).toHaveValue("Validation is optional in Miscellaneous");
});

test("settings → connections → GitHub: add, test, warn, webhook secret; assigned issue → inbox → accept; signed webhook", async ({ page, request }) => {
  test.setTimeout(120_000);
  await removeConnections(page);
  await page.goto("/settings/connections");
  await page.getByRole("button", { name: /^GitHub/ }).click();
  const panel = page.locator("#panel-github");
  await expect(panel.getByTestId("gh-token-link")).toHaveAttribute(
    "href",
    /personal-access-tokens\/new\?name=Jarvis%20read-only&target_name=.*pull_requests=read&issues=read/,
  );

  // Add a fine-grained read-only token with an allowlist.
  await panel.getByRole("button", { name: "Add token" }).click();
  const add = page.getByRole("dialog", { name: "Add a GitHub token" });
  await add.getByLabel("Label", { exact: true }).fill("Momentum org");
  await add.getByLabel("Owner (user or organization)").fill("momentumbets");
  await add.getByLabel("Token", { exact: true }).fill(READONLY_TOKEN);
  await add.getByLabel("Repository allowlist (optional)").fill("odds-feed");
  await add.getByRole("button", { name: "Save" }).click();
  await expect(add).toHaveCount(0);
  const row = panel.getByTestId("gh-connection").filter({ hasText: "Momentum org" });
  await expect(row).toContainText("•••• 0002");
  await expect(row).toContainText("Repos: odds-feed");
  // Write-only: the token never comes back to the browser.
  expect(await (await page.request.get("/api/github")).text()).not.toContain(READONLY_TOKEN);
  expect(await page.content()).not.toContain(READONLY_TOKEN);

  await row.getByRole("button", { name: "Test Momentum org" }).click();
  await expect(row.getByRole("status")).toContainText("Read access works");
  await expect(row).toContainText("GET /repos/momentumbets/odds-feed");
  await expect(row).toContainText("Signed in as NickBolles");
  await expect(row.getByText("Read-only", { exact: true })).toBeVisible();

  // Swap in a classic token with write scopes: Test warns loudly.
  await row.getByRole("button", { name: "Edit Momentum org" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Momentum org" });
  await edit.getByLabel("Replace token (optional)").fill(CLASSIC_TOKEN);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText("•••• 0003");
  await row.getByRole("button", { name: "Test Momentum org" }).click();
  await expect(row.getByTestId("gh-warning").first()).toHaveText("This token can write — Jarvis only needs read. Prefer a fine-grained read-only token.");
  await expect(row).toContainText("scopes: repo, workflow, read:org");
  // Back to the read-only one for the rest of the test.
  await row.getByRole("button", { name: "Edit Momentum org" }).click();
  await page.getByRole("dialog", { name: "Edit Momentum org" }).getByLabel("Replace token (optional)").fill(READONLY_TOKEN);
  await page.getByRole("dialog", { name: "Edit Momentum org" }).getByRole("button", { name: "Save" }).click();
  await row.getByRole("button", { name: "Test Momentum org" }).click();
  await expect(row.getByRole("status")).toContainText("Read access works");

  // Webhook: URL + a secret shown exactly once.
  await expect(panel.getByLabel("Payload URL")).toHaveValue(/\/api\/work\/github\/webhook$/);
  const generate = panel.getByRole("button", { name: "Generate secret" });
  if (await generate.count()) await generate.click();
  else {
    // A retry on the same server: the secret already exists.
    await panel.getByRole("button", { name: "Regenerate secret" }).click();
    await page.getByRole("dialog", { name: "Regenerate the webhook secret?" }).getByRole("button", { name: "Regenerate" }).click();
  }
  const secret = await panel.getByTestId("gh-secret").inputValue();
  expect(secret.length).toBeGreaterThan(30);
  await page.reload();
  await page.getByRole("button", { name: /^GitHub/ }).click();
  await expect(page.locator("#panel-github")).toContainText("(hidden)");
  await expect(page.locator("#panel-github").getByTestId("gh-secret")).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);

  // An issue assigned to the token's user on (mock) GitHub → Check now → Work inbox.
  const nonce = Date.now() % 100000;
  const issue = { owner: "momentumbets", repo: "odds-feed", number: nonce, title: `Bet slip shows stale odds ${nonce}`, assignee: "NickBolles", state: "open" };
  expect((await request.post(`${MOCK_URL}/github/__mock/issue`, { data: issue })).ok()).toBeTruthy();
  await page.locator("#panel-github").getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("gh-poll-result")).toContainText("assigned issues");

  await page.goto("/areas?view=inbox");
  const entry = page.locator("[data-inbox-entry]", { hasText: issue.title });
  await expect(entry).toContainText("GitHub issue");
  await expect(entry).toContainText("Why: Assigned to you on GitHub (momentumbets)");
  await expect(entry.getByRole("link", { name: /Open/ })).toHaveAttribute("href", `https://github.com/momentumbets/odds-feed/issues/${nonce}`);
  await entry.getByRole("button", { name: `Accept: ${issue.title}` }).click();
  const acc = page.getByRole("dialog", { name: "Accept into Work" });
  await acc.getByLabel("The issue is").selectOption("implementation");
  await acc.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: issue.title })).toBeVisible();
  const itemId = new URL(page.url()).searchParams.get("item")!;
  const detail = await api<{ links: { kind: string; role: string; url: string }[] }>(page, "get", `/api/work/items/${itemId}`);
  expect(detail.links).toEqual([
    expect.objectContaining({ kind: "github_issue", role: "implementation", url: `https://github.com/momentumbets/odds-feed/issues/${nonce}` }),
  ]);
  // Accepted entries don't come back on the next check.
  await api(page, "post", "/api/github/poll");
  const inbox = await api<{ items: { title: string }[] }>(page, "get", "/api/work/inbox");
  expect(inbox.items.map((i) => i.title)).not.toContain(issue.title);

  // A signed pull_request webhook for a linked PR moves the item (read-only, exactly once); a bad signature is refused.
  await api(page, "post", `/api/work/items/${itemId}/links`, { kind: "github_pr", url: `https://github.com/momentumbets/odds-feed/pull/${nonce}` });
  const payload = JSON.stringify({
    action: "closed",
    repository: { full_name: "momentumbets/odds-feed" },
    pull_request: { number: nonce, state: "closed", merged: true, title: "Fix stale odds" },
  });
  const sign = (s: string) => `sha256=${crypto.createHmac("sha256", s).update(payload).digest("hex")}`;
  const send = (sig: string, delivery: string) =>
    request.post("/api/work/github/webhook", {
      data: payload,
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": delivery, "x-hub-signature-256": sig },
    });
  expect((await send(sign("wrong"), `e2e-${nonce}-bad`)).status()).toBe(401);
  const ok = await send(sign(secret), `e2e-${nonce}`);
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ linked: 1, changed: 1 });
  expect(await (await send(sign(secret), `e2e-${nonce}`)).json()).toMatchObject({ duplicate: true });
  const after = await api<{ item: { status: string } }>(page, "get", `/api/work/items/${itemId}`);
  expect(after.item.status).toBe("awaiting_validation");

  // Remove (UI) and leave no connection behind for later specs.
  await page.goto("/settings/connections#github");
  const row2 = page.locator("#panel-github").getByTestId("gh-connection").filter({ hasText: "Momentum org" });
  await row2.getByRole("button", { name: "Remove Momentum org" }).click();
  await page.getByRole("dialog", { name: "Remove Momentum org?" }).getByRole("button", { name: "Remove token" }).click();
  await expect(row2).toHaveCount(0);
  await removeConnections(page);
});

test("command dock: tap opens the radial menu, Search opens the palette, hold-and-slide runs an action, release on the orb cancels, Ctrl+. works", async ({
  page,
}) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  const o = orb(page);
  await expect(o).toBeVisible();

  // Tap → radial command menu (focus on the first action); Esc returns focus to the orb.
  await o.click();
  await expect(page.locator('[data-petal="search"]')).toBeFocused();
  await expect(o).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(actionMap(page)).toHaveCount(0);
  await expect(o).toBeFocused();
  // Search in the radial menu → command palette with Work commands.
  await openPalette(page);
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  await box.fill("inbox");
  await expect(page.locator('[data-command="work.inbox"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/areas\?view=inbox/);
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();

  // Hold → radial map; slide onto "Go to", pause for its sub-menu, slide to "Timeline", release.
  const start = await centre(o);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(actionMap(page)).toBeVisible();
  const goto = await centre(page.locator('[data-petal="goto"]'));
  await page.mouse.move(goto.x, goto.y, { steps: 6 });
  await expect(page.locator('[data-sub="work.timeline"]')).toBeVisible();
  const tl = await centre(page.locator('[data-sub="work.timeline"]'));
  await page.mouse.move(tl.x, tl.y, { steps: 6 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/areas\/timeline/);
  await expect(actionMap(page)).toHaveCount(0);

  // Release on the orb cancels: nothing runs, no palette.
  const o2 = await centre(orb(page));
  await page.mouse.move(o2.x, o2.y);
  await page.mouse.down();
  await expect(actionMap(page)).toBeVisible();
  await page.mouse.move(o2.x + 3, o2.y - 3);
  await page.mouse.up();
  await expect(actionMap(page)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Search Jarvis" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/areas\/timeline/);

  // Keyboard: Ctrl+. opens the map; arrows choose, Tab opens a sub-menu, Enter runs, Esc closes.
  await page.keyboard.press("Control+.");
  await expect(actionMap(page)).toBeVisible();
  await expect(page.locator('[data-petal="search"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actionMap(page)).toHaveCount(0);
  await page.keyboard.press("Control+.");
  await page.keyboard.press("ArrowRight"); // Capture
  await page.keyboard.press("ArrowRight"); // Go to
  await expect(page.locator('[data-petal="goto"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-sub="work.today"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/areas$/);
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();

  // Capture from the map's Capture petal: the quick-capture dialog.
  await page.keyboard.press("Control+.");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter"); // open Capture's sub-menu
  await page.keyboard.press("Enter"); // run "Quick note to Inbox"
  await expect(page.getByRole("dialog", { name: "Capture" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("palette commands act on the open item: start focused work and record validation", async ({ page }) => {
  const { item: area } = await api<{ item: { id: string } }>(page, "post", "/api/work/items", {
    kind: "area",
    title: `Dock checks ${Date.now().toString(36)}`,
  });
  const { item } = await api<{ item: { id: string } }>(page, "post", "/api/work/items", { kind: "thread", title: "Hydration perf", parentId: area.id });
  await api(page, "post", `/api/work/items/${item.id}/validations`, { metric: "p95 hydration", comparator: "<=", threshold: 1.2, unit: "s" });
  await page.goto(`/areas?item=${item.id}`);
  await expect(page.getByRole("heading", { level: 2, name: "Hydration perf" })).toBeVisible();
  await openPalette(page);
  await page.getByRole("combobox", { name: "Search Jarvis" }).fill("focused");
  await page.locator('[data-command="work.packet"]').click();
  await expect(page.getByRole("dialog", { name: "Start focused work" })).toBeVisible();
  // Non-Home/Misc area: validation required by default.
  await expect(page.getByRole("dialog").getByLabel("Validation required before settling")).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await openPalette(page);
  await page.getByRole("combobox", { name: "Search Jarvis" }).fill("record validation");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Observed value for p95 hydration")).toBeFocused();
  await page.getByLabel("Observed value for p95 hydration").fill("0.9");
  await page.getByRole("button", { name: "Record p95 hydration" }).click();
  await expect(page.locator("li", { hasText: "p95 hydration ≤ 1.2 s" }).getByText("Pass", { exact: true })).toBeVisible();
});

test.describe("phone, 320 px", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test("Today, inbox and the packet dialog fit; the dialog's primary action stays reachable", async ({ page }) => {
    await page.goto("/areas");
    await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto("/areas?view=inbox");
    await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const r = await appPost(page, "/api/work/items", { kind: "thread", title: "Phone packet check" });
    const { item } = (await r.json()) as { item: { id: string } };
    await page.goto(`/areas?item=${item.id}&do=packet`);
    const dialog = page.getByRole("dialog", { name: "Start focused work" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save packet" })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    // The orb is the centre of the bottom bar, lifted 20px (§5), never floating over content.
    const bar = await page.getByRole("navigation", { name: "Primary" }).last().boundingBox();
    const o = await orb(page).boundingBox();
    expect(o!.y).toBeGreaterThanOrEqual(bar!.y - 21);
    expect(o!.y + o!.height).toBeLessThanOrEqual(bar!.y + bar!.height + 1);
  });
});
