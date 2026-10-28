import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/**
 * Settings → AI → Usage meter: subscription billing (Codex) reads the Hermes usage
 * snapshot (playwright.config.ts JARVIS_HERMES_USAGE_FILE). States: ok, stop (≥48%),
 * stale (> 2 h) and missing (fail closed); each one is accessible and doesn't overflow.
 */
const FILE = path.resolve("e2e/.tmp/hermes-usage.json");

function writeUsage(pct: number, at = new Date()) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const iso = at.toISOString();
  fs.writeFileSync(
    FILE,
    JSON.stringify({ version: 1, fetched_at: iso, providers: { "openai-codex": { weekly_used_percent: pct, weekly_resets_at: null, fetched_at: iso } } }),
  );
}

async function putAi(page: Page, body: unknown) {
  const r = await page.request.put("/api/settings/ai", { data: body, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

async function expectAccessible(page: Page) {
  await expectNoHorizontalOverflow(page);
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }, testInfo) => {
  fs.rmSync(FILE, { force: true });
  const ctx = await browser.newContext({ storageState: "e2e/.auth/state.json", baseURL: testInfo.project.use.baseURL });
  const page = await ctx.newPage();
  await putAi(page, { billing: { mode: "api", stopAtPct: 48 } });
  await ctx.close();
});

test("usage meter: Codex % of week, paused at 48%, stale and missing fail closed", async ({ page }) => {
  // API billing: the $ budget, no meter.
  await page.goto("/settings/ai");
  await expect(page.getByRole("heading", { name: "Usage meter" })).toBeVisible();
  await expect(page.getByText("Pay per token: jobs are gated by the daily $ budget below.")).toBeVisible();

  // Switch to Codex in the form.
  writeUsage(12);
  await page.getByLabel("Hermes billing").selectOption("codex");
  await page.getByRole("button", { name: "Save meter" }).click();
  const meter = page.getByTestId("ai-usage-meter");
  await expect(meter).toHaveAttribute("data-state", "ok");
  await expect(meter.getByText("Codex 12% of week")).toBeVisible();
  await expect(page.getByRole("meter", { name: "Codex weekly usage" })).toHaveAttribute("aria-valuenow", "12");
  await expect(page.getByText("Background AI on")).toBeVisible();
  await expectAccessible(page);

  writeUsage(55);
  await page.reload();
  await expect(meter).toHaveAttribute("data-state", "stop");
  await expect(page.getByText("Background AI paused")).toBeVisible();
  await expect(meter.getByRole("status")).toContainText("Codex is at 55% of this week");
  await expectAccessible(page);

  writeUsage(5, new Date(Date.now() - 3 * 3600_000));
  await page.reload();
  await expect(meter).toHaveAttribute("data-state", "stale");
  await expect(meter.getByRole("status")).toContainText("more than 2 hours old");

  fs.rmSync(FILE, { force: true });
  await page.reload();
  await expect(meter).toHaveAttribute("data-state", "missing");
  await expect(meter.getByRole("status")).toContainText("can't be read");
  await expectAccessible(page);
});
