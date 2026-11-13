/**
 * Skylight-style grouping on the strict mock: overdue rows sit in a red Overdue group at the bottom and their
 * suggested actions (Do now, Skip) write through the confirm card and undo. Nothing is written to real Skylight.
 */
import { expect, test, type Page } from "@playwright/test";
import { freshSkylightBudget, MOCK_URL, mock } from "./helpers";
import { addDays, localDate } from "../lib/time";

const H = { "x-jarvis-csrf": "1" };
type Write = { method: string; path: string; body: Record<string, unknown> };
let previous: { enabled: boolean; config: Record<string, string> } | undefined;

async function writes(page: Page): Promise<Write[]> {
  const response = await page.request.get(`${MOCK_URL}/__mock/skylight/writes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { writes: Write[] }).writes;
}

async function undo(page: Page) {
  await page
    .getByRole("status")
    .filter({ has: page.getByRole("button", { name: "Undo", exact: true }) })
    .getByRole("button", { name: "Undo", exact: true })
    .click();
}

test.beforeEach(async ({ page, request }) => {
  previous = undefined;
  await mock(request, "/reset");
  const settings = await page.request.get("/api/integrations/skylight");
  expect(settings.ok()).toBe(true);
  const { enabled, config } = await settings.json();
  previous = { enabled, config };
  const configured = await page.request.put("/api/integrations/skylight", {
    headers: H,
    data: { enabled: true, config: { ...config, mode: "direct", frameId: "4418006", members: "13600771", includeUpForGrabs: "true", writes: "true" } },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const readback = await page.request.get("/api/integrations/skylight");
  expect((await readback.json()).config.writes).toBe("true");
  const refreshed = await page.request.get("/api/sources/skylight");
  expect(refreshed.ok()).toBe(true);
  expect((await refreshed.json()).data.extra.writable).toBe(true);
});

test.afterEach(async ({ page, request }) => {
  await mock(request, "/reset");
  if (previous) {
    const restored = await page.request.put("/api/integrations/skylight", {
      headers: H,
      data: {
        enabled: previous.enabled,
        config: {
          ...previous.config,
          // Unset = the default (on); never leave a non-default behind for later specs.
          writes: previous.config.writes ?? "",
          members: previous.config.members ?? "",
          frameId: previous.config.frameId ?? "",
          includeUpForGrabs: previous.config.includeUpForGrabs ?? "true",
        },
      },
    });
    expect(restored.ok()).toBe(true);
    expect((await page.request.get("/api/sources/skylight")).ok()).toBe(true);
  }
});

// Writes are budgeted at 12/min per user (integrations/skylight/write.ts) and skylight-write.spec spends ~11 when it
// ran earlier on this worker's server: start with a fresh budget so Undo is never rate limited.
test.beforeAll(async ({ request }) => {
  test.setTimeout(90_000);
  await freshSkylightBudget(request);
});

/** Seed chores in the strict mock (frame-local dates) and resync the source. */
async function addChores(page: Page, chores: Record<string, unknown>[]) {
  for (const c of chores) {
    const r = await page.request.post(`${MOCK_URL}/__mock/skylight/chores`, { data: c });
    expect(r.ok(), await r.text()).toBe(true);
  }
  expect((await page.request.get("/api/sources/skylight?refresh=1")).ok()).toBe(true);
}
const frameDay = (n: number) => addDays(localDate(new Date(), "America/Chicago"), n);

test("skygroup: overdue chores sit in a red Overdue group at the bottom; Do now completes the occurrence and Undo reopens it", async ({ page }) => {
  const day = frameDay(-1);
  const id = `88344853-${day}-0600`;
  await addChores(page, [{ id, summary: "Skygroup feed the fish", category: "13600771", start: day, start_time: "06:00" }]);
  await page.goto("/skylight");
  const overdue = page.getByRole("region", { name: /^Overdue/ });
  await expect(overdue).toContainText("Skygroup feed the fish", { timeout: 15_000 });
  // Overdue is the last chore group: only Done this week follows it.
  const labels = await page.locator("section[aria-labelledby^=sk-]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-labelledby")));
  expect(labels.filter((l) => l !== "sk-lists" && l !== "sk-events").slice(-2)).toEqual(["sk-overdue", "sk-done"]);
  const row = overdue.getByRole("article", { name: /Skygroup feed the fish/ });
  await expect(row.locator("[data-due-tone=danger]").filter({ hasText: /^Due / }).first()).toBeAttached();
  // Recurring: Do now + Skip only (no Move to today).
  const group = row.getByRole("group", { name: /Suggested actions/ });
  await expect(group.getByRole("button")).toHaveCount(2);
  await group.getByRole("button", { name: /^Do now: / }).click();
  await expect(page.getByRole("dialog", { name: "Confirm Skylight change" })).toHaveCount(0);
  await expect(page.getByTestId("skylight-done")).toContainText("Skygroup feed the fish");
  await expect
    .poll(async () =>
      (await writes(page))
        .filter((w) => w.method === "PUT" && w.path.endsWith("/chores/88344853/completions"))
        .map((w) => [w.body.status, w.body.instance_date, w.body.instance_time, "category_id" in w.body]),
    )
    .toEqual([["complete", day, "06:00", false]]);
  await undo(page);
  await expect
    .poll(async () => (await writes(page)).filter((w) => w.path.endsWith("/chores/88344853/completions")).map((w) => w.body.status))
    .toEqual(["complete", "pending"]);
  // Back in Overdue (a reload re-reads the source if an in-flight refresh raced the undo).
  await expect(async () => {
    await page.reload();
    await expect(overdue).toContainText("Skygroup feed the fish", { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
});

test("skygroup: Skip on an overdue one-off chore marks it skipped and Undo reopens it", async ({ page }) => {
  const day = frameDay(-3);
  await addChores(page, [{ id: "88344900", summary: "Skygroup descale the kettle", category: "13600771", start: day }]);
  await page.goto("/skylight");
  const row = page.getByRole("region", { name: /^Overdue/ }).getByRole("article", { name: /Skygroup descale the kettle/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator("[data-due-tone=danger]").filter({ hasText: "Due 3 days ago" }).first()).toBeAttached();
  await expect(row.getByRole("button", { name: /^Move to today: / })).toBeVisible();
  await row.getByRole("button", { name: /^Skip: / }).click();
  await expect(page.getByRole("dialog", { name: "Confirm Skylight change" })).toHaveCount(0);
  await expect(page.getByTestId("sk-skipped")).toContainText("Skygroup descale the kettle");
  await expect(row).toHaveCount(0);
  await expect
    .poll(async () =>
      (await writes(page)).filter((w) => w.path.endsWith("/chores/88344900/completions")).map((w) => [w.body.status, w.body.instance_date ?? null]),
    )
    .toEqual([["skipped", null]]);
  await undo(page);
  await expect(row).toBeVisible();
  await expect
    .poll(async () => (await writes(page)).filter((w) => w.path.endsWith("/chores/88344900/completions")).map((w) => w.body.status))
    .toEqual(["skipped", "pending"]);
});

test("skygroup: Skip is available today; recurring Undo changes only the clicked time instance", async ({ page }) => {
  const day = frameDay(0);
  await addChores(page, [
    { id: `88344901-${day}-0600`, summary: "Skygroup morning routine", category: "13600771", start: day, start_time: "06:00", rrule: "FREQ=DAILY" },
    { id: `88344901-${day}-2000`, summary: "Skygroup evening routine", category: "13600771", start: day, start_time: "20:00", rrule: "FREQ=DAILY" },
  ]);
  await page.goto("/skylight");
  await page.getByRole("button", { name: "Skip: Skygroup morning routine", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Confirm Skylight change" })).toHaveCount(0);
  await expect(page.getByTestId("sk-skipped")).toContainText("Skygroup morning routine");
  await expect(page.getByTestId("skylight-done")).not.toContainText("Skygroup morning routine");
  await expect(page.getByRole("checkbox", { name: "Done: Skygroup evening routine", exact: true })).toBeVisible();
  await undo(page);
  await expect(page.getByRole("checkbox", { name: "Done: Skygroup morning routine", exact: true })).toBeVisible();
  expect((await writes(page)).filter((w) => w.path.endsWith("/chores/88344901/completions"))).toEqual([
    { method: "PUT", path: "/api/frames/4418006/chores/88344901/completions", body: { status: "skipped", instance_date: day, instance_time: "06:00" } },
    { method: "PUT", path: "/api/frames/4418006/chores/88344901/completions", body: { status: "pending", instance_date: day, instance_time: "06:00" } },
  ]);
});
