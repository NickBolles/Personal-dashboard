import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mock } from "./helpers";

// Smart replies (jarvis-ui@1): overdue triage renders as rows, changes stage
// in a tray, one Apply writes them with readback, Undo reverts one. Runs on
// mobile and desktop (file name matches the desktop project's /chat.spec/).

const TASKS = [
  { title: "Smartui fence repair", dueDays: -4 },
  { title: "Smartui return parcel", dueDays: -5 },
  { title: "Smartui old raffle", dueDays: -6 },
];

async function api(page: Page, method: "post" | "put", path: string, data: unknown) {
  const res = await page.request[method](path, { data, headers: { "x-jarvis-csrf": "1" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
  await mock(request, "/google/tasks", { tasks: TASKS });
});

test.afterEach(async ({ page, request }) => {
  await page.request.put("/api/smart/settings", { data: { enabled: false }, headers: { "x-jarvis-csrf": "1" } });
  await mock(request, "/reset");
});

test("overdue triage: smart rows → stage in the tray → apply with readback → undo one", async ({ page }) => {
  await api(page, "put", "/api/smart/settings", { enabled: true });
  // Load the todos so Jarvis' snapshot has the new overdue tasks.
  await page.goto("/todos");
  await expect(page.getByText("Smartui fence repair").first()).toBeVisible({ timeout: 15_000 });

  const { id } = (await api(page, "post", "/api/hermes/sessions", { title: "Smartui triage" })) as { id: string };
  await api(page, "post", `/api/hermes/sessions/${encodeURIComponent(id)}/runs`, {
    input: "Help me triage my overdue tasks",
    idempotencyKey: `smartui-${Date.now()}`,
    context: "@ctx:overdue_todos",
    capabilities: ["jarvis-ui@1"],
  });
  await page.goto(`/chat/${encodeURIComponent(id)}`);

  const surface = page.getByTestId("smart-surface").first();
  await expect(surface).toBeVisible({ timeout: 20_000 });
  await expect(surface.locator("li.smart-row")).toHaveCount(4);
  await expect(surface.getByText("Smartui fence repair")).toBeVisible();
  // Raw JSON never shows.
  await expect(page.getByText('"catalog":"jarvis-ui@1"')).toHaveCount(0);

  const tray = surface.getByTestId("smart-tray-count");
  await expect(tray).toHaveText("Nothing changes until you apply");
  await surface.getByRole("button", { name: /^This week .*: Renew car registration$/ }).click();
  await surface.getByRole("button", { name: /^Reschedule .*: Smartui fence repair$/ }).click();
  await surface.getByRole("button", { name: "Drop: Smartui return parcel" }).click();
  await expect(tray).toHaveText("3 changes staged");

  await surface.getByRole("button", { name: "Review" }).click();
  const review = surface.getByRole("list", { name: "Staged changes" });
  await expect(review).toContainText("Drop “Smartui return parcel” (marked done with a dropped note)");
  await expect(review).toContainText("Move “Smartui fence repair” to");

  const axe = await new AxeBuilder({ page: page as never }).include("[data-testid=smart-surface]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

  await surface.getByRole("button", { name: "Apply 3 changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "3 changes applied" })).toBeVisible({ timeout: 15_000 });
  await expect(tray).toHaveText("Nothing changes until you apply");
  await expect(surface.getByRole("button", { name: /^Undo: / })).toHaveCount(3);

  // Applied state survives a reload (stored on the surface, not in the page).
  await page.reload();
  const again = page.getByTestId("smart-surface").first();
  await expect(again.getByRole("button", { name: /^Undo: / })).toHaveCount(3, { timeout: 20_000 });
  await again.getByRole("button", { name: "Undo: Smartui return parcel" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Undone" })).toBeVisible({ timeout: 15_000 });
  await expect(again.getByRole("button", { name: /^Undo: / })).toHaveCount(2);
  await expect(again.getByRole("button", { name: "Drop: Smartui return parcel" })).toBeVisible();
});

test("with smart replies off, the reply shows its summary and no JSON", async ({ page }) => {
  await page.goto("/todos");
  await expect(page.getByText("Smartui fence repair").first()).toBeVisible({ timeout: 15_000 });
  await api(page, "put", "/api/smart/settings", { enabled: true });
  const { id } = (await api(page, "post", "/api/hermes/sessions", { title: "Smartui off" })) as { id: string };
  await api(page, "post", `/api/hermes/sessions/${encodeURIComponent(id)}/runs`, {
    input: "Help me triage my overdue tasks",
    idempotencyKey: `smartui-off-${Date.now()}`,
    context: "@ctx:overdue_todos",
    capabilities: ["jarvis-ui@1"],
  });
  await api(page, "put", "/api/smart/settings", { enabled: false });
  await page.goto(`/chat/${encodeURIComponent(id)}`);
  await expect(page.getByText(/Here's a pass on 4 overdue todos/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Turn on Smart replies in Settings")).toBeVisible();
  await expect(page.getByTestId("smart-surface")).toHaveCount(0);
  await expect(page.getByText('"catalog"')).toHaveCount(0);
});
