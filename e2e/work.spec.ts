import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * Flagship Work journey (docs/work.md): Momentum Bets → Criteria evaluator →
 * V2..V5 → split a bug → focused work packet → PR merged → awaiting
 * validation → failing then passing evidence → settle → reopen. Plus the
 * timeline and the sandboxed custom HTML dashboard widget.
 */

function treeItem(page: Page, title: string) {
  return page.getByRole("treeitem", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`) });
}
/** Phones fold the tree behind the Work header's Areas toggle while an item is open. */
async function showTree(page: Page) {
  const toggle = page.getByTestId("work-tree-toggle");
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
/** Phones fold secondary item sections (Details, Dependencies, Links) into disclosures. */
async function openSection(page: Page, testId: string) {
  const section = page.getByTestId(testId);
  if ((await section.evaluate((el) => el.tagName)) === "DETAILS" && !(await section.evaluate((el) => (el as HTMLDetailsElement).open)))
    await section.locator("summary").click();
}
async function pick(page: Page, title: string) {
  await showTree(page);
  // Click the row itself, not the centre of the <li> (which may be a nested child).
  await treeItem(page, title).locator("> div").click();
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
}
async function newChild(page: Page, parent: string, title: string) {
  await pick(page, parent);
  await page.getByRole("button", { name: "New child", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // Retries share one server: archive any earlier run's flagship area so names stay unique.
  const res = await page.request.get("/api/work/items");
  expect(res.ok()).toBeTruthy();
  const { items } = (await res.json()) as { items: { id: string; title: string; parentId: string | null }[] };
  for (const i of items.filter((x) => x.parentId === null && x.title === "Momentum Bets")) {
    const r = await page.request.patch(`/api/work/items/${i.id}`, { data: { archived: true }, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok()).toBeTruthy();
  }
});

test("work: organize, hand off, merge, validate, settle and reopen", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/home");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Areas", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Areas" })).toBeVisible();
  await expect(treeItem(page, "Miscellaneous")).toBeVisible();

  await page.getByRole("button", { name: "New area" }).click();
  await page.getByRole("dialog").getByLabel("Title", { exact: true }).fill("Momentum Bets");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Momentum Bets" })).toBeVisible();
  await expect(page).toHaveURL(/\/areas\?item=wk_/);

  await newChild(page, "Momentum Bets", "Criteria evaluator");
  for (const t of ["V2 baseline", "V3 parity", "V4 lessons", "V5 evaluator contract"]) await newChild(page, "Criteria evaluator", t);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Momentum Bets›Criteria evaluator›");

  // Split the perf bug out of V5; the source is untouched and lineage is recorded.
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Split into child" }).click();
  await page.getByLabel("Child title").fill("Hydration perf bug");
  await page.getByLabel("Summary excerpt").fill("p95 hydration regressed after the V5 contract change");
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Hydration perf bug" })).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Split from V5 evaluator contract");

  // Fork it too: a sibling with forked_from lineage.
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Fork" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Fork", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Hydration perf bug (fork)" })).toBeVisible();

  // Keyboard: the tree is one tab stop; arrows move, Enter selects.
  await showTree(page);
  await treeItem(page, "Hydration perf bug (fork)").focus();
  await page.keyboard.press("ArrowUp");
  await expect(treeItem(page, "Hydration perf bug")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Hydration perf bug", exact: true })).toBeVisible();

  // Start focused work on V5: needs an objective and a next action.
  await pick(page, "V5 evaluator contract");
  await page.getByRole("button", { name: "Start focused work" }).click();
  await page.getByLabel("Objective").fill("Define the V5 evaluator contract and keep hydration fast");
  await page.getByLabel("Decisions").fill("Keep V4 scoring weights");
  await page.getByLabel("Open questions").fill("Do we need a V3 parity backfill?");
  await page.getByRole("dialog").getByLabel("Next action", { exact: true }).fill("Open the evaluator contract PR");
  await page.getByRole("button", { name: "Save packet" }).click();
  await expect(page.getByRole("heading", { name: "Work packet v1" })).toBeVisible();
  const header = page.getByRole("article").locator("section").first();
  const badge = (s: string) => header.locator(`[data-status="${s}"]`);
  await expect(badge("in_progress")).toBeVisible();
  await expect(header).toContainText("Open the evaluator contract PR");
  await page.getByText("Preview handoff").click();
  const handoff = page.getByTestId("handoff-preview");
  await expect(handoff).toContainText("Handoff: V5 evaluator contract");
  await expect(handoff).toContainText("- Keep V4 scoring weights");
  await expect(handoff).toContainText("## Next action\nOpen the evaluator contract PR");

  // Link the PR, then mark it merged: validation is required, so it waits.
  await page.getByRole("button", { name: "Link PR" }).click();
  await page.getByLabel("GitHub PR URL").fill("https://github.com/NickBolles/momentum-bets/pull/128");
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByText("NickBolles/momentum-bets#128", { exact: true })).toBeVisible();
  await expect(page.getByText(/Add a GitHub token \(Settings → Connections → GitHub\)/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark merged" }).click();
  await expect(badge("awaiting_validation")).toBeVisible();
  const settle = page.getByRole("button", { name: "Settle", exact: true });
  await expect(settle).toBeDisabled();
  await expect(page.getByText("The work packet requires validation. Add one first.", { exact: true })).toBeVisible();

  // Declare the measurement contract and record evidence.
  await page.getByRole("button", { name: "Add validation" }).click();
  await page.getByLabel("Metric").fill("p95 hydration");
  await page.getByLabel("Comparator").selectOption("<=");
  await page.getByLabel("Threshold").fill("800");
  await page.getByLabel("Unit").fill("ms");
  await page.getByLabel("Baseline (optional)").fill("1200");
  await page.getByRole("button", { name: "Save validation" }).click();
  await expect(page.getByText("p95 hydration <= 800 ms", { exact: true })).toBeVisible();
  await page.getByLabel("Observed value for p95 hydration").fill("950");
  await page.getByRole("button", { name: "Record p95 hydration" }).click();
  await expect(page.getByText("Fail", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen with failed evidence" })).toBeVisible();
  await expect(settle).toBeDisabled();
  await page.getByLabel("Observed value for p95 hydration").fill("640");
  await page.getByLabel("Evidence link").fill("https://example.com/hydration-run");
  await page.getByRole("button", { name: "Record p95 hydration" }).click();
  await expect(page.getByText("Pass", { exact: true })).toBeVisible();
  await expect(settle).toBeEnabled();
  await settle.click();
  await page.getByLabel("Outcome (optional)").fill("p95 hydration 640 ms on the evaluator page");
  await page.getByRole("dialog").getByRole("button", { name: "Settle", exact: true }).click();
  await expect(badge("settled")).toBeVisible();
  await expect(header).toContainText("p95 hydration 640 ms on the evaluator page");
  await expectNoHorizontalOverflow(page);

  // Reopen is always available on settled work.
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByLabel("Why is it reopening?").fill("Regressed on low-end Android");
  await page.getByRole("dialog").getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(badge("reopened")).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  for (const t of [
    "Captured → In progress",
    "In progress → Awaiting validation: PR #128 merged; awaiting validation",
    "Awaiting validation → Settled",
    "Settled → Reopened",
  ])
    await expect(page.getByRole("tabpanel")).toContainText(t);

  // Persisted: reload lands on the same item.
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "V5 evaluator contract" })).toBeVisible();
  await expect(badge("reopened")).toBeVisible();

  // Search finds work items.
  const found = await page.request.get("/api/search?q=hydration");
  expect(((await found.json()) as { results: { kind: string; title: string }[] }).results.filter((r) => r.kind === "work").map((r) => r.title)).toContain(
    "Hydration perf bug",
  );

  // Timeline: the evaluator project, chart and table, row → item.
  await page.goto("/areas/timeline");
  await page.getByLabel("Area or project").selectOption({ label: "Criteria evaluator" });
  await expect(page.getByRole("link", { name: /^V5 evaluator contract: / })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Show as table" }).click();
  const table = page.getByRole("table", { name: "Work timeline" });
  await expect(table).toContainText("V5 evaluator contract");
  await expect(table).toContainText("PR merged");
  await table.getByRole("link", { name: "V4 lessons" }).click();
  await expect(page).toHaveURL(/\/areas\?item=/);
  await expect(page.getByRole("heading", { level: 2, name: "V4 lessons" })).toBeVisible();
});

test("work dashboard: native widgets and a sandboxed custom HTML widget", async ({ page }) => {
  // Seed through the real API (the journey above covers the UI).
  const post = async (path: string, data: unknown) => {
    const r = await appPost(page, path, data);
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const { item: area } = await post("/api/work/items", { kind: "area", title: "Momentum Bets" });
  const { item: project } = await post("/api/work/items", { kind: "project", title: "Criteria evaluator", parentId: area.id });
  const { item: v5 } = await post("/api/work/items", { kind: "thread", title: "V5 evaluator contract", parentId: project.id });
  await post(`/api/work/items/${v5.id}/packets`, {
    objective: "Contract",
    nextAction: "Open the PR",
    validationRequired: false,
    noValidationReason: "Docs only",
  });
  const { link } = await post(`/api/work/items/${v5.id}/links`, { kind: "github_pr", url: "https://github.com/o/r/pull/7" });
  const merged = await page.request.patch(`/api/work/links/${link.id}`, { data: { externalState: "merged" }, headers: { "x-jarvis-csrf": "1" } });
  expect(merged.ok()).toBeTruthy();
  // Auto-settle: never. The merge leaves it ready to settle; settling is a manual action.
  const detail = await (await page.request.get(`/api/work/items/${v5.id}`)).json();
  expect(detail.item.status).toBe("ready_to_settle");
  await post(`/api/work/items/${v5.id}/settle`, { reason: "Docs merged and read" });

  await page.goto("/areas/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  const settled = page.getByRole("region", { name: "Recently settled" });
  await expect(settled).toContainText("V5 evaluator contract");
  await expect(settled).not.toContainText("Auto-settled");
  await expect(settled).toContainText("Docs merged and read");

  await page.getByRole("button", { name: "Edit dashboard" }).click();
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByLabel("Widget type").selectOption("custom_html");
  await page.getByLabel("Title", { exact: true }).fill("Sandbox probe");
  await page.getByLabel("Area or project").selectOption({ label: "Momentum Bets" });
  const html = `<p id="out">waiting</p>
<script>
  var out = document.getElementById("out");
  var parentAccess = "blocked", cookie = "blocked", storage = "blocked";
  try { parentAccess = parent.document.title ? "OPEN" : "OPEN"; } catch (e) {}
  try { cookie = document.cookie === "" ? "empty" : "LEAK"; } catch (e) {}
  try { localStorage.length; storage = "OPEN"; } catch (e) {}
  out.textContent = "parent:" + parentAccess + " cookie:" + cookie + " storage:" + storage;
  function add(id, text) { var p = document.createElement("p"); p.id = id; p.textContent = text; document.body.appendChild(p); }
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "jarvis.work.snapshot") add("snap", "snapshot:" + e.data.data.root + ":" + e.data.data.items.length);
  });
  fetch("/api/work/items").then(function () { add("fetch", "fetch:OPEN"); }, function () { add("fetch", "fetch:blocked"); });
</script>`;
  await page.getByLabel("HTML", { exact: true }).fill(html);
  await page.getByLabel(/Send this widget a read-only snapshot/).check();
  await page.getByRole("dialog").getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Done editing" }).click();

  const widget = page.getByRole("region", { name: "Sandbox probe" });
  await expect(widget.getByText("Custom HTML (sandboxed)", { exact: false })).toBeVisible();
  const iframe = widget.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("title", "Sandbox probe");
  const srcdoc = (await iframe.getAttribute("srcdoc")) ?? "";
  expect(srcdoc).toContain(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">`,
  );
  expect(srcdoc).not.toContain("allow-same-origin");
  // The author's markup never lands in the app document.
  expect(await page.locator("body > div p#out, main p#out").count()).toBe(0);
  const frame = page.frameLocator('iframe[title="Sandbox probe"]');
  await expect(frame.locator("#out")).toHaveText("parent:blocked cookie:blocked storage:blocked");
  await expect(frame.locator("#fetch")).toHaveText("fetch:blocked");
  await expect(frame.locator("#snap")).toHaveText("snapshot:Momentum Bets:3");
  await expectNoHorizontalOverflow(page);

  // Reorder and remove in edit mode.
  await page.getByRole("button", { name: "Edit dashboard" }).click();
  await page.getByRole("button", { name: "Move Sandbox probe earlier" }).click();
  await expect(page.locator("[data-widget]").nth(3)).toHaveAttribute("data-widget", "custom_html");
  await page.getByRole("button", { name: "Remove Sandbox probe" }).click();
  await expect(page.getByRole("region", { name: "Sandbox probe" })).toHaveCount(0);
});

// ---------------------------------------------------------------- phase 2

type Item = { id: string; title: string; parentId: string | null; archived: boolean; startDate: string | null; targetDate: string | null };

async function seedFlagship(page: Page) {
  const post = async (path: string, data: unknown) => {
    const r = await appPost(page, path, data);
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const { item: area } = await post("/api/work/items", { kind: "area", title: "Momentum Bets" });
  const { item: project } = await post("/api/work/items", { kind: "project", title: "Criteria evaluator", parentId: area.id });
  const ids: Record<string, string> = { area: area.id, project: project.id };
  for (const t of ["V2 baseline", "V3 parity", "V4 lessons", "V5 evaluator contract"]) {
    const { item } = await post("/api/work/items", { kind: "thread", title: t, parentId: project.id });
    ids[t] = item.id;
  }
  return { ids, post };
}

async function items(page: Page) {
  const res = await page.request.get("/api/work/items");
  return ((await res.json()) as { items: Item[] }).items;
}

/** Drag with real pointer events from one element's centre to a point inside another. */
async function dragTo(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>, at: { x: number; y: number } = { x: 0.5, y: 0.5 }) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const tx = b.x + b.width * at.x;
  const ty = b.y + b.height * at.y;
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 3 });
  await page.mouse.move(tx, ty, { steps: 12 });
  await page.mouse.up();
}

test("work: conversation picker, unfiled filing, continue in a new conversation (draft only), drag-and-drop and undo", async ({ page }) => {
  test.setTimeout(120_000);
  const { ids, post } = await seedFlagship(page);
  const nonce = Date.now().toString(36);
  const picked = await post("/api/hermes/sessions", { title: `Picker check ${nonce}`, backend: "hermes" });
  const unfiled = await post("/api/hermes/sessions", { title: `V5 evaluator hydration notes ${nonce}`, backend: "hermes" });
  const loose = await post("/api/hermes/sessions", { title: `Loose thought ${nonce}`, backend: "hermes" });

  await page.goto(`/areas?item=${ids["V5 evaluator contract"]}`);
  await expect(page.getByRole("heading", { level: 2, name: "V5 evaluator contract" })).toBeVisible();

  // Picker: search your conversations and link one (no pasting ids).
  await page.getByRole("button", { name: "Link conversation" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a conversation" });
  await dialog.getByLabel("Search conversations").fill(`Picker check ${nonce}`);
  await dialog.getByRole("button", { name: `Link Picker check ${nonce}` }).click();
  await expect(dialog).toHaveCount(0);
  const links = page.getByRole("article").locator("li", { hasText: `Picker check ${nonce}` });
  await expect(links.first()).toContainText("Last activity");
  await expect(links.first().getByRole("link", { name: /Open conversation/ })).toHaveAttribute("href", `/chat/${picked.id}`);

  // New chats land in Miscellaneous with zero filing; the conversations view's Unfiled filter files them in one tap.
  await page.goto("/chat?view=unfiled");
  const conv = (t: string) => page.locator("[data-conversation]", { hasText: t });
  await expect(conv(`V5 evaluator hydration notes ${nonce}`)).toBeVisible();
  await expect(conv(`Loose thought ${nonce}`)).toContainText("Miscellaneous");
  // Linked to V5 above, so it counts as filed.
  await expect(conv(`Picker check ${nonce}`)).toHaveCount(0);
  await conv(`V5 evaluator hydration notes ${nonce}`)
    .getByRole("button", { name: `File under V5 evaluator contract: V5 evaluator hydration notes ${nonce}` })
    .click();
  await expect(conv(`V5 evaluator hydration notes ${nonce}`)).toHaveCount(0);
  await page.getByRole("button", { name: "All conversations" }).click();
  await expect(conv(`V5 evaluator hydration notes ${nonce}`)).toContainText("V5 evaluator contract");
  expect(unfiled.id).toBeTruthy();
  expect(loose.id).toBeTruthy();
  await page.goto(`/areas?item=${ids["V5 evaluator contract"]}`);
  await showTree(page);
  // The filed chat is now a conversation node under V5; the linked one is a child row too.
  await expect(treeItem(page, `V5 evaluator hydration notes ${nonce}`)).toHaveAttribute("aria-label", /conversation/);
  await expect(page.getByRole("treeitem", { name: `Picker check ${nonce}, linked conversation` })).toBeVisible();

  // Continue in a new conversation: the handoff is a draft in the composer; nothing is sent.
  await page.getByRole("button", { name: "Continue in new conversation" }).click();
  const cont = page.getByRole("dialog", { name: "Continue in a new conversation" });
  await expect(cont.getByTestId("continue-preview")).toContainText("# Handoff: V5 evaluator contract");
  await cont.getByRole("button", { name: "Create conversation" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/?]+$/);
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  const composer = page.locator("#composer");
  await expect(composer).toHaveValue(/# Handoff: V5 evaluator contract/);
  await expect(composer).toHaveValue(/\*\*Where:\*\* Momentum Bets › Criteria evaluator › V5 evaluator contract/);
  await page.waitForTimeout(500);
  const detail = (await (await page.request.get(`/api/hermes/sessions/${encodeURIComponent(sessionId)}`)).json()) as { timeline: unknown[] };
  expect(detail.timeline).toEqual([]);
  await page.goto(`/areas?item=${ids["V5 evaluator contract"]}`);
  await openSection(page, "work-links");
  await expect(page.getByRole("article").getByText("started from the handoff", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Continued in a new conversation (handoff, no packet yet)");
  await expect(page.getByRole("tabpanel")).toContainText("Handed off to");

  // Drag-and-drop: drop V2 onto the middle of V4 → it becomes V4's child (moved_from recorded).
  await showTree(page);
  const handle = page.locator(`[data-drag-handle="${ids["V2 baseline"]}"]`);
  const target = page.locator(`[data-row-id="${ids["V4 lessons"]}"]`);
  await dragTo(page, handle, target);
  await expect.poll(async () => (await items(page)).find((i) => i.id === ids["V2 baseline"])?.parentId).toBe(ids["V4 lessons"]);
  // Undo (shown for ~10 s) puts it back.
  const undo = page.getByRole("status").filter({ hasText: "Moved" });
  await expect(undo).toBeVisible();
  await undo.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await items(page)).find((i) => i.id === ids["V2 baseline"])?.parentId).toBe(ids.project);

  // Reorder by dragging onto the top edge of V2: V5 goes first among the project's children.
  await dragTo(page, page.locator(`[data-drag-handle="${ids["V5 evaluator contract"]}"]`), page.locator(`[data-row-id="${ids["V2 baseline"]}"]`), {
    x: 0.5,
    y: 0.1,
  });
  await expect
    .poll(async () =>
      (await items(page))
        .filter((i) => i.parentId === ids.project)
        .map((i) => i.title)
        .join("|"),
    )
    .toBe("V5 evaluator contract|V2 baseline|V3 parity|V4 lessons");

  // Undo an archive from the item menu.
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect.poll(async () => (await items(page)).some((i) => i.id === ids["V5 evaluator contract"])).toBe(false);
  await page.getByRole("status").filter({ hasText: "Archived" }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await items(page)).some((i) => i.id === ids["V5 evaluator contract"])).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("work: timeline date editing and dependencies, validation templates, the map", async ({ page }) => {
  test.setTimeout(120_000);
  const { ids, post } = await seedFlagship(page);
  const patch = async (id: string, data: unknown) => {
    const r = await page.request.patch(`/api/work/items/${id}`, { data, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  const day = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  await patch(ids["V4 lessons"], { startDate: day(0), targetDate: day(3) });
  await patch(ids["V5 evaluator contract"], { startDate: day(4), targetDate: day(8) });
  await post(`/api/work/items/${ids["V5 evaluator contract"]}/dependencies`, { dependsOnId: ids["V4 lessons"] });

  await page.goto(`/areas/timeline?root=${ids.project}`);
  await expect(page.locator("[data-connectors]")).toHaveAttribute("data-connectors", "1");
  // Drag V5's bar two days later (weeks zoom: 28 px a day).
  const bar = page.locator(`[data-bar="${ids["V5 evaluator contract"]}"]`);
  await bar.scrollIntoViewIfNeeded();
  const box = (await bar.boundingBox())!;
  // Grab the right part of the bar (the sticky label column can cover its left part), away from the end handle.
  const gx = box.x + box.width - 24;
  await page.mouse.move(gx, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(gx + 56, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await items(page)).find((i) => i.id === ids["V5 evaluator contract"])?.startDate).toBe(day(6));
  expect((await items(page)).find((i) => i.id === ids["V5 evaluator contract"])?.targetDate).toBe(day(10));

  // Keyboard/form alternative: the table's Edit dates.
  await page.getByRole("button", { name: "Show as table" }).click();
  await page.getByRole("button", { name: "Edit dates for V4 lessons" }).click();
  const dd = page.getByRole("dialog", { name: "Dates for V4 lessons" });
  await dd.getByLabel("Target date").fill(day(5));
  await dd.getByRole("button", { name: "Save dates" }).click();
  await expect.poll(async () => (await items(page)).find((i) => i.id === ids["V4 lessons"])?.targetDate).toBe(day(5));
  await expect(page.getByRole("table", { name: "Work timeline" })).toContainText("Blocked");

  // Item detail: blocked-by, date events, a validation from a template, overdue highlighting.
  await page.goto(`/areas?item=${ids["V5 evaluator contract"]}`);
  await expect(page.getByRole("article")).toContainText("Blocked by");
  await expect(page.getByRole("article").getByRole("button", { name: "V4 lessons", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add from template" }).click();
  const td = page.getByRole("dialog", { name: "Add from template" });
  await td.getByText("New template").click();
  await td.getByLabel("Template metric").fill("p95 hydration");
  await td.getByLabel("Threshold").fill("800");
  await td.getByLabel("Unit").fill("ms");
  await td.getByLabel("Due after (days, optional)").fill("7");
  await td.getByRole("button", { name: "Save template" }).click();
  await td.getByRole("button", { name: "Add p95 hydration" }).click();
  await expect(page.getByText("p95 hydration <= 800 ms", { exact: true })).toBeVisible();
  await post(`/api/work/items/${ids["V5 evaluator contract"]}/validations`, {
    metric: "error rate",
    comparator: "<",
    threshold: 1,
    unit: "%",
    dueDate: day(-2),
  });
  await page.reload();
  await expect(page.getByTestId("validation-overdue")).toContainText("1 validation is overdue");
  await expect(page.locator("[data-overdue]")).toContainText("error rate");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tabpanel")).toContainText(`Dates: start ${day(4)} → ${day(6)}`);

  // Map: read-only graph with relation and status filters, list alternative, click → item.
  await page.goto(`/areas/map?root=${ids.area}`);
  await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible();
  const svg = page.getByRole("group", { name: "Work map: Momentum Bets" });
  await expect(svg).toHaveAttribute("data-map-nodes", "6");
  await expect(svg.locator('[data-edge="depends_on"]')).toHaveCount(1);
  await page.getByLabel("Contains").uncheck();
  await expect(svg.locator('[data-edge="tree"]')).toHaveCount(0);
  await page.getByLabel("Status").selectOption("settled");
  await expect(svg).toHaveAttribute("data-map-nodes", "0");
  await page.getByLabel("Status").selectOption("all");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Show as list" }).click();
  await expect(page.getByRole("main")).toContainText("Depends on");
  await page.getByRole("button", { name: "Show map" }).click();
  await page.getByRole("button", { name: "Fit" }).click();
  await svg.getByRole("link", { name: /^V4 lessons,/ }).click();
  await expect(page).toHaveURL(new RegExp(`/areas\\?item=${ids["V4 lessons"]}`));
  await expect(page.getByRole("heading", { level: 2, name: "V4 lessons" })).toBeVisible();
});

test("work dashboard: resize, drag reorder and the new widgets", async ({ page }) => {
  const { ids, post } = await seedFlagship(page);
  await post(`/api/work/items/${ids["V5 evaluator contract"]}/validations`, {
    metric: "p95 hydration",
    comparator: "<=",
    threshold: 800,
    unit: "ms",
    dueDate: "2020-01-01",
  });
  await page.goto("/areas/dashboard");
  await page.getByRole("button", { name: "Edit dashboard" }).click();
  for (const [kind, extra] of [
    ["validation_overdue", null],
    ["map_snapshot", "Momentum Bets"],
    ["unfiled_conversations", null],
  ] as const) {
    await page.getByRole("button", { name: "Add widget" }).click();
    await page.getByLabel("Widget type").selectOption(kind);
    if (extra) await page.getByLabel("Area or project").selectOption({ label: extra });
    await page.getByRole("dialog").getByRole("button", { name: "Add widget" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(page.getByRole("region", { name: "Validation overdue" }).getByTestId("overdue-count")).not.toHaveText("0");
  await expect(page.getByRole("region", { name: "Validation overdue" })).toContainText("V5 evaluator contract");
  await expect(page.getByRole("region", { name: "Map snapshot" }).locator("svg[data-map-nodes]")).toBeVisible();
  await expect(page.getByRole("region", { name: "Unfiled conversations" })).toContainText("not filed under any work");

  // Resize: S / M / L in edit mode.
  const widgetLi = (title: string) => page.locator("li[data-widget-index]").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await page.getByRole("group", { name: "Size of Priorities" }).getByRole("button", { name: "Large" }).click();
  await expect(widgetLi("Priorities")).toHaveAttribute("data-size", "lg");
  await expect(page.getByRole("group", { name: "Size of Priorities" }).getByRole("button", { name: "Large" })).toHaveAttribute("aria-pressed", "true");

  // Drag reorder: the second widget onto the first one's slot (the ↑/↓ buttons are the keyboard way).
  const order = async () => ((await (await page.request.get("/api/work/dashboard")).json()) as { widgets: { title: string }[] }).widgets.map((w) => w.title);
  const before = await order();
  await page.evaluate(() => window.scrollTo(0, 0));
  await dragTo(page, page.locator('li[data-widget-index="1"] [data-widget-handle]'), page.locator('li[data-widget-index="0"]'), { x: 0.5, y: 0.3 });
  await expect.poll(async () => (await order())[0]).toBe(before[1]);
  expect((await order())[1]).toBe(before[0]);
  await expectNoHorizontalOverflow(page);
});
