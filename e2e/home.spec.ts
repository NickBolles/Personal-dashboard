import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, mock, setHa } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("Now shows at most three ranked actions with provenance", async ({ page, request }) => {
  await setHa(request, "cover.garage_door", "open", 45);
  await page.goto("/home");
  const now = page
    .getByRole("list")
    .filter({ has: page.getByRole("article") })
    .first();
  const cards = page.locator("section[aria-labelledby=now-h] article");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeLessThanOrEqual(3);
  // Highest priority first: home-critical, then Hermes/Paperclip awaiting you, then overdue.
  await expect(cards.nth(0)).toContainText("Home Assistant");
  await expect(cards.nth(0)).toContainText("Needs attention now");
  await expect(cards.nth(0)).toContainText("Garage door");
  // Every card shows its source and reason
  for (let i = 0; i < (await cards.count()); i++) {
    await expect(cards.nth(i).locator("span.text-muted").first()).toBeVisible();
  }
  void now;
});

test("complete a todo only reports success after upstream readback", async ({ page, request }) => {
  await setHa(request, "cover.garage_door", "closed");
  await page.goto("/home");
  // Due today, so it's within Now or Later today (two-day-overdue tasks wait in the backlog by design).
  const card = page.locator("article", { hasText: "Call plumber about water heater" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked done" })).toBeVisible();
  await expect(page.locator("article", { hasText: "Call plumber about water heater" })).toHaveCount(0);
});

async function resetTuning(page: Page) {
  const res = await page.request.delete("/api/home/tuning", { data: { scope: "all" }, headers: { "x-jarvis-csrf": "1" } });
  expect(res.ok()).toBeTruthy();
}

const overdue = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Overdue errand ${i + 1}`, dueDays: -(3 + i) }));

test("Home keeps to its attention budget and counts the rest honestly", async ({ page, request }) => {
  await mock(request, "/google/tasks", { tasks: overdue(12) });
  await page.goto("/home");
  await resetTuning(page);
  await page.reload();
  await expect(page.locator("section[aria-labelledby=now-h] article").first()).toBeVisible();
  expect(await page.locator("section[aria-labelledby=now-h] article").count()).toBeLessThanOrEqual(3);
  expect(await page.locator("section[aria-labelledby=today-h] article").count()).toBeLessThanOrEqual(5);
  // Long-overdue errands are never promoted into Now.
  await expect(page.locator("section[aria-labelledby=now-h] article", { hasText: "Overdue errand" })).toHaveCount(0);
  const backlog = page.getByRole("link", { name: /Backlog/ });
  await expect(backlog).toContainText(/overdue/);
  await backlog.click();
  await expect(page.getByRole("heading", { name: "All of Home" })).toBeVisible();
  await expect(page.getByText(/\d+ items\./)).toBeVisible();
  await expect(page.locator("#all-items article", { hasText: "Overdue errand" }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test.describe("household-timezone triage", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  test("overdue triage reschedules only the tasks picked, after confirmation and readback", async ({ page, request }) => {
    // Just after household midnight on fall-back day; the device is still Oct 31.
    await page.clock.setFixedTime(new Date("2026-11-01T05:30:00Z"));
    const mutations: string[] = [];
    const dates: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/actions") {
        mutations.push(r.postDataJSON().actionId);
        dates.push(r.postDataJSON().until);
      }
    });
    await mock(request, "/google/tasks", { tasks: overdue(6) });
    await page.goto("/home");
    await resetTuning(page);
    await page.reload();
    const card = page.locator("section[aria-labelledby=assist-h] article", { hasText: "Overdue tasks are piling up" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Suggestion from your data");
    await card.getByRole("button", { name: "Review & reschedule" }).click();
    const dialog = page.getByRole("dialog", { name: "Reschedule overdue tasks" });
    const review = dialog.getByRole("button", { name: /Review/ });
    await expect(review).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "Overdue errand 1", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Overdue errand 2", exact: true }).check();
    await expect(review).toBeDisabled(); // no date yet
    await expect(dialog).toContainText("Dates use household timezone: America/Chicago");
    await expect(dialog.getByLabel("Or pick a date")).toHaveAttribute("min", "2026-11-02");
    await dialog.getByRole("button", { name: "Tomorrow" }).click();
    await expect(dialog.getByLabel("Or pick a date")).toHaveValue("2026-11-02");
    await review.click();
    const confirm = page.getByRole("dialog", { name: "Confirm new due date" });
    await expect(confirm).toContainText("Move 2 tasks");
    expect(mutations).toEqual([]); // selection and review are read-only
    await confirm.getByRole("button", { name: "Confirm and reschedule" }).click();
    await expect(page.getByRole("dialog").getByText(/Now due/)).toHaveCount(2, { timeout: 15_000 });
    expect(mutations).toHaveLength(2);
    expect(dates).toEqual(["2026-11-02", "2026-11-02"]);
    expect(new Set(mutations).size).toBe(2);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved 2 tasks" })).toBeVisible();
  });
});

test("suggestion feedback is reversible from Settings → Home priorities", async ({ page, request }) => {
  await mock(request, "/google/tasks", { tasks: overdue(6) });
  await page.goto("/home");
  await resetTuning(page);
  await page.reload();
  const card = page.locator("section[aria-labelledby=assist-h] article", { hasText: "Overdue tasks are piling up" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByText("Why am I seeing this?").click();
  await expect(card).toContainText("Counted from your Todos");
  await card.getByRole("button", { name: "Not now" }).click();
  await card.getByRole("button", { name: "Until tomorrow" }).click();
  await expect(page.locator("section[aria-labelledby=assist-h] article", { hasText: "Overdue tasks are piling up" })).toHaveCount(0);

  await page.goto("/settings/home");
  await expect(page.getByRole("heading", { name: "Home priorities", level: 1 })).toBeVisible();
  const hidden = page.locator("li", { hasText: "Overdue triage suggestion" });
  await hidden.getByRole("button", { name: "Show again" }).click();
  await page.goto("/home");
  await expect(page.locator("section[aria-labelledby=assist-h] article", { hasText: "Overdue tasks are piling up" })).toBeVisible();
});

test("every Now card explains itself", async ({ page }) => {
  await page.goto("/home");
  const first = page.locator("section[aria-labelledby=now-h] article").first();
  await expect(first).toBeVisible();
  await first.getByText("Why this?").click();
  await expect(first.locator("details li").first()).toBeVisible();
  await expect(first).toHaveAttribute("data-tier", "critical");
  await expect(first.getByText("Safety alerts can’t be hidden or ranked lower.")).toBeVisible();
  await expect(first.getByRole("button", { name: /Not now|Less like this|Ranked wrong/ })).toHaveCount(0);
});

test("one failed source never blocks Home, and is not shown as empty", async ({ page, request }) => {
  await page.goto("/home");
  await expect(page.locator("section[aria-labelledby=now-h] article").first()).toBeVisible();
  await mock(request, "/fail", { services: ["todos"] });
  await page.reload();
  await expect(page.getByText(/Todos:/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/couldn’t refresh/)).toBeVisible();
  // Other sources still render
  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();
  await mock(request, "/fail", { restore: ["todos"] });
});

test("unknown home state is labelled, not rendered as 'no exceptions'", async ({ page, request }) => {
  await mock(request, "/fail", { services: ["home_assistant"] });
  await page.goto("/home");
  await expect(page.getByText(/Home Assistant:/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("section[aria-labelledby=glance-h]").getByText("No exceptions")).toHaveCount(0);
  await mock(request, "/fail", { restore: ["home_assistant"] });
});

test("Home capture: Enter goes to the Inbox; Ask Hermes starts a conversation and streams a reply", async ({ page }) => {
  await page.goto("/home");
  const box = page.getByLabel("Capture or ask Hermes");
  const nonce = Date.now().toString(36);
  await box.fill(`Renew the car registration ${nonce}`);
  await box.press("Enter");
  await expect(page.getByText("Captured to your Inbox")).toBeVisible();
  await expect(box).toHaveValue("");
  const inbox = (await (await page.request.get("/api/work/inbox")).json()) as { items: { title: string; id: string }[] };
  const captured = inbox.items.find((i) => i.title === `Renew the car registration ${nonce}`);
  expect(captured).toBeTruthy();
  await page.request.post(`/api/work/inbox/${captured!.id}/dismiss`, { headers: { "x-jarvis-csrf": "1" } });

  await box.fill("What is the weather?");
  await page.getByRole("button", { name: "Ask Hermes", exact: true }).click();
  await page.waitForURL(/\/chat\/.+/);
  // A fast run can finish before the live step renders; then it is folded into the "searched 1 source" summary.
  await expect(page.getByText(/Searched the web|searched 1 source/).first()).toBeVisible();
  await expect(page.getByText(/Here's what I found/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
});

test("Today counts: approvals, validation and merged KPIs link to their views, with a 14-day trend", async ({ page }) => {
  await page.goto("/home");
  const strip = page.getByLabel("Today at a glance");
  await expect(strip).toBeVisible();
  // Real counts from local data; each a way in.
  await expect(strip.getByRole("link", { name: /^Approvals waiting: \d+$/ })).toHaveAttribute("href", "/alerts");
  await expect(strip.getByRole("link", { name: /^Awaiting validation: \d+$/ })).toHaveAttribute("href", "/areas#today-proof");
  await expect(strip.getByRole("link", { name: /^Merged, not settled: \d+$/ })).toHaveAttribute("href", "/areas#today-settle");
  await expect(page.getByTestId("today-trend")).toContainText(/\d+ completed vs \d+ added · 14 days/);
  await strip.getByRole("link", { name: /^Awaiting validation/ }).click();
  await expect(page).toHaveURL(/\/areas#today-proof$/);
  await expect(page.getByTestId("work-today")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
