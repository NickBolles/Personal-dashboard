import { expect, test, type Page } from "@playwright/test";
import { MOCK_URL, mock } from "./helpers";
import { addDays, localDate } from "../lib/time";

const H = { "x-jarvis-csrf": "1" };
type Write = { method: string; path: string; body: Record<string, unknown> };
let previous: { enabled: boolean; config: Record<string, string> } | undefined;

async function writes(page: Page): Promise<Write[]> {
  const response = await page.request.get(`${MOCK_URL}/__mock/skylight/writes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { writes: Write[] }).writes;
}
async function confirm(page: Page, text: string | RegExp) {
  const dialog = page.getByRole("dialog", { name: "Confirm Skylight change" });
  await expect(dialog).toContainText(text);
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(dialog).toBeHidden();
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

test("skywrite completes a Nick chore and undoes its completion", async ({ page }) => {
  await page.goto("/skylight");
  const check = page.getByRole("checkbox", { name: /Done: .*Take out recycling/ });
  await expect(check).toBeVisible();
  await check.click();
  await confirm(page, /Mark “.*Take out recycling” done in Skylight/);
  await expect(page.getByTestId("skylight-done")).toContainText("Take out recycling");
  await expect(check).toHaveCount(0);
  await expect
    .poll(async () => (await writes(page)).some((w) => w.method === "PUT" && /\/chores\/55780859\/completions$/.test(w.path) && w.body.status === "complete"))
    .toBe(true);
  await undo(page);
  await expect(check).toBeVisible();
  await expect(page.getByTestId("skylight-done")).not.toContainText("Take out recycling");
  await expect
    .poll(async () => (await writes(page)).filter((w) => /\/chores\/55780859\/completions$/.test(w.path)).map((w) => w.body.status))
    .toEqual(["complete", "pending"]);
});

test("skywrite claims the porch chore and restores its assignment with Undo", async ({ page }) => {
  await page.goto("/skylight");
  const claim = page.getByRole("button", { name: /Claim: .*Water the porch plants/ });
  const source = await page.request.get("/api/sources/skylight");
  const { data } = await source.json();
  const chore = data.actions.find((a: { title: string }) => a.title.includes("Water the porch plants"));
  expect(chore?.skylight?.choreId).toBeTruthy();
  await claim.click();
  await confirm(page, /Claim “.*Water the porch plants”/);
  await expect(claim).toHaveCount(0);
  await expect
    .poll(async () =>
      (await writes(page)).some((w) => w.method === "PUT" && w.path.endsWith(`/chores/${chore.skylight.choreId}`) && w.body.category_id === 13600771),
    )
    .toBe(true);
  await undo(page);
  await expect(claim).toBeVisible();
  const assignmentWrites = (await writes(page)).filter((w) => w.method === "PUT" && w.path.endsWith(`/chores/${chore.skylight.choreId}`));
  expect(assignmentWrites).toHaveLength(2);
  expect(assignmentWrites[1].body.category_id).toBe(chore.skylight.categoryId === null ? null : Number(chore.skylight.categoryId));
});

test("skywrite adds groceries, checks oat milk and undoes the check", async ({ page }) => {
  await page.goto("/skylight");
  const groceries = page.getByRole("article", { name: "Groceries", exact: true });
  await groceries.getByRole("textbox", { name: "Add to Groceries" }).fill("Skywrite lemons");
  await groceries.getByRole("button", { name: "Add", exact: true }).click();
  await confirm(page, "Add “Skywrite lemons” to Groceries");
  await expect(groceries.getByRole("checkbox", { name: "Skywrite lemons", exact: true })).toBeVisible();
  const oat = groceries.getByRole("checkbox", { name: "Oat milk", exact: true });
  await oat.click();
  // No optimistic check: confirmation must precede any upstream mutation.
  await expect(oat).not.toBeChecked();
  await confirm(page, "Check off “Oat milk” on Groceries");
  await expect(oat).toBeChecked();
  await undo(page);
  await expect(oat).not.toBeChecked();
});

test("skywrite creates, edits, deletes and restores a calendar event", async ({ page }) => {
  await page.goto("/skylight");
  await page.getByRole("button", { name: "New event", exact: true }).click();
  const form = page.getByRole("dialog", { name: "New event", exact: true });
  await form.getByRole("textbox", { name: "Title", exact: true }).fill("Skywrite lantern walk");
  await form.getByLabel("Date", { exact: true }).fill(addDays(localDate(new Date(), "America/Chicago"), 1));
  await form.getByLabel("Start", { exact: true }).fill("14:00");
  await form.getByLabel("End", { exact: true }).fill("15:00");
  await form.getByRole("textbox", { name: "Location" }).fill("Skywrite trailhead");
  await form.getByRole("button", { name: "Review change", exact: true }).click();
  await confirm(page, "Add “Skywrite lantern walk” to the family calendar");
  await expect(page.getByText("Skywrite lantern walk", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Skywrite lantern walk", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit event", exact: true });
  await expect(edit.getByRole("textbox", { name: "Location" })).toHaveValue("Skywrite trailhead");
  await edit.getByRole("textbox", { name: "Title", exact: true }).fill("Skywrite lantern stroll");
  await edit.getByRole("button", { name: "Review change", exact: true }).click();
  await confirm(page, "Change “Skywrite lantern walk” on the family calendar");
  await expect(page.getByText("Skywrite lantern stroll", { exact: true })).toBeVisible();
  await expect(page.getByText("Skywrite lantern walk", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete Skywrite lantern stroll", exact: true }).click();
  await confirm(page, "Delete “Skywrite lantern stroll” from the family calendar");
  await expect(page.getByText("Skywrite lantern stroll", { exact: true })).toHaveCount(0);
  await undo(page);
  await expect(page.getByText("Skywrite lantern stroll", { exact: true })).toBeVisible();
});

test("skywrite Cancel sends no mutation and returns focus", async ({ page }) => {
  await page.goto("/skylight");
  const check = page.getByRole("checkbox", { name: /Done: .*Take out recycling/ });
  const before = await writes(page);
  await check.click();
  const dialog = page.getByRole("dialog", { name: "Confirm Skylight change" });
  await expect(dialog).toContainText("Take out recycling");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(check).toBeFocused();
  expect(await writes(page)).toEqual(before);
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
  await confirm(page, /Mark “Skygroup feed the fish” done in Skylight/);
  await expect(page.getByTestId("skylight-done")).toContainText("Skygroup feed the fish");
  await expect
    .poll(async () =>
      (await writes(page))
        .filter((w) => w.method === "PUT" && w.path.endsWith("/chores/88344853/completions"))
        .map((w) => [w.body.status, w.body.instance_date, w.body.instance_time, "category_id" in w.body]),
    )
    .toEqual([["complete", day, "06:00", false]]);
  await undo(page);
  await expect(overdue).toContainText("Skygroup feed the fish");
  await expect
    .poll(async () => (await writes(page)).filter((w) => w.path.endsWith("/chores/88344853/completions")).map((w) => w.body.status))
    .toEqual(["complete", "pending"]);
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
  await confirm(page, /Skip “Skygroup descale the kettle”/);
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
