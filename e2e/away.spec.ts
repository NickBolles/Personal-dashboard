import { expect, test } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow, mock } from "./helpers";
import { SUGGESTED_TEMPLATES, type AwayDigest } from "../lib/away";
import { DEFAULT_AREA_SETTINGS, type WorkItem } from "../lib/work";

const headers = { "x-jarvis-csrf": "1" };
let areaId: string | null = null;
let jobId: string | null = null;
let originalSettings: WorkItem["settings"] = null;
const decisionIds = new Set<string>();

test.afterEach(async ({ page }) => {
  // Cleanup even after a failed assertion; only this test's area/job are touched.
  try {
    if (areaId) {
      const digestResponse = await page.request.get("/api/agents/away");
      if (digestResponse.ok()) {
        const digest = (await digestResponse.json()) as AwayDigest;
        for (const run of digest.runs.filter((r) => r.areaId === areaId)) for (const decision of run.decisions) decisionIds.add(decision.itemId);
      }
    }
    for (const id of decisionIds) {
      const clear = await page.request.patch(`/api/work/items/${id}`, { headers, data: { decision: null } });
      expect(clear.ok(), await clear.text()).toBe(true);
    }
    if (jobId) {
      const removed = await page.request.delete(`/api/agents/schedules/${jobId}`, { headers });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
    if (areaId) {
      const restored = await page.request.patch(`/api/work/items/${areaId}`, {
        headers,
        data: { archived: true, settings: originalSettings ?? DEFAULT_AREA_SETTINGS },
      });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
  } finally {
    areaId = null;
    jobId = null;
    originalSettings = null;
    decisionIds.clear();
  }
});

test("scheduled run: low-risk change, owner decision, refused deploy and dismiss", async ({ page, request }, info) => {
  test.skip(info.project.name !== "mobile", "One isolated real-server run on the mobile project");
  test.setTimeout(120_000);
  await mock(request, "/reset");
  const areaResponse = await appPost(page, "/api/work/items", { kind: "area", title: "Lantern workshop" });
  expect(areaResponse.ok(), await areaResponse.text()).toBe(true);
  const { item } = (await areaResponse.json()) as { item: WorkItem };
  areaId = item.id;
  originalSettings = item.settings;
  const configured = await page.request.patch(`/api/work/items/${areaId}`, { headers, data: { settings: { autonomy: "low_risk", agentMode: "devchief" } } });
  expect(configured.ok(), await configured.text()).toBe(true);
  const title = `Lantern check ${Date.now().toString(36)}`;
  const jobResponse = await appPost(page, "/api/agents/schedules", {
    title,
    areaId,
    kind: "custom",
    prompt: "Overnight check SCHEDULED_PROPOSALS",
    enabled: false,
    overnight: true,
    schedule: { freq: "daily", time: "05:30", days: [] },
  });
  expect(jobResponse.status(), await jobResponse.text()).toBe(201);
  jobId = (await jobResponse.json()).job.id;
  await page.goto("/settings/agents#schedules");
  const schedules = page.locator("#schedules");
  for (const template of SUGGESTED_TEMPLATES) await expect(schedules.getByRole("switch", { name: `Enable ${template.title}`, exact: true })).not.toBeChecked();
  const row = schedules.getByTestId("scheduled-job").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByRole("switch")).not.toBeChecked();
  await row.getByRole("button", { name: `More for scheduled job ${title}` }).click();
  await page.getByRole("menuitem", { name: "Run now…" }).click();
  const confirm = page.getByRole("dialog", { name: "Run job now?" });
  await expect(confirm).toContainText("Act on low-risk");
  await expect(confirm).toContainText("Hermes subscription");
  const started = page.waitForResponse((r) => r.url().endsWith(`/api/agents/schedules/${jobId}/run`) && r.request().method() === "POST");
  await confirm.getByRole("button", { name: "Run now", exact: true }).click();
  expect((await started).status()).toBe(202);
  await expect(confirm).toBeHidden();
  await page.goto("/home");
  const card = page.locator("main").getByTestId("while-away").first();
  const runRow = card.getByTestId("away-run").filter({ hasText: title });
  await expect(async () => {
    // The GET reconciles the scheduled run on the real server; reload observes it without waiting a full polling minute.
    const digestResponse = await page.request.get("/api/agents/away");
    expect(digestResponse.ok()).toBe(true);
    const digest = (await digestResponse.json()) as AwayDigest;
    const run = digest.runs.find((r) => r.jobId === jobId);
    expect(run?.status).toBe("done");
    for (const decision of run?.decisions ?? []) decisionIds.add(decision.itemId);
    await page.reload();
    await expect(runRow.getByRole("button", { name: "1 change", exact: true })).toBeVisible();
    await expect(runRow.getByRole("link", { name: "1 needs you", exact: true })).toBeVisible();
    await expect(runRow).toContainText("Skipped: deploy (Jarvis never deploys)");
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 4000] });
  await expectNoHorizontalOverflow(page);
  await runRow.getByRole("link", { name: "1 needs you", exact: true }).click();
  await expect(page).toHaveURL(/\/decisions$/);
  await expect(page.getByTestId("decision-row").filter({ hasText: "Lantern" }).first()).toBeVisible();
  await page.goto("/home");
  await card.getByRole("button", { name: "Dismiss while you were away" }).click();
  await expect(card).toHaveCount(0);
  const hidden = await page.request.get("/api/agents/away");
  expect(((await hidden.json()) as AwayDigest).runs).toHaveLength(0);
});
