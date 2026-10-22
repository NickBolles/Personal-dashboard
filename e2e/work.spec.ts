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
async function pick(page: Page, title: string) {
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
  await page.goto("/more");
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Work" })).toBeVisible();
  await expect(treeItem(page, "Miscellaneous")).toBeVisible();

  await page.getByRole("button", { name: "New area" }).click();
  await page.getByRole("dialog").getByLabel("Title", { exact: true }).fill("Momentum Bets");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Momentum Bets" })).toBeVisible();
  await expect(page).toHaveURL(/\/work\?item=wk_/);

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
  await expect(handoff).toContainText("# Handoff: V5 evaluator contract");
  await expect(handoff).toContainText("- Keep V4 scoring weights");
  await expect(handoff).toContainText("## Next action\nOpen the evaluator contract PR");

  // Link the PR, then mark it merged: validation is required, so it waits.
  await page.getByRole("button", { name: "Link PR" }).click();
  await page.getByLabel("GitHub PR URL").fill("https://github.com/NickBolles/momentum-bets/pull/128");
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByText("NickBolles/momentum-bets#128", { exact: true })).toBeVisible();
  await expect(page.getByText(/Set JARVIS_GITHUB_TOKEN/)).toBeVisible();
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
  await page.goto("/work/timeline");
  await page.getByLabel("Area or project").selectOption({ label: "Criteria evaluator" });
  await expect(page.getByRole("link", { name: /^V5 evaluator contract: / })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Show as table" }).click();
  const table = page.getByRole("table", { name: "Work timeline" });
  await expect(table).toContainText("V5 evaluator contract");
  await expect(table).toContainText("PR merged");
  await table.getByRole("link", { name: "V4 lessons" }).click();
  await expect(page).toHaveURL(/\/work\?item=/);
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

  await page.goto("/work/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  const settled = page.getByRole("region", { name: "Recently settled" });
  await expect(settled).toContainText("V5 evaluator contract");
  await expect(settled).toContainText("Auto-settled");
  await expect(settled).toContainText("PR #7 merged; no validation required");

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
