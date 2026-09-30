import { expect, test } from "@playwright/test";
import { mock, setHa } from "./helpers";

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
  const card = page.locator("article", { hasText: "Renew car registration" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked done" })).toBeVisible();
  await expect(page.locator("section[aria-labelledby=now-h] article", { hasText: "Renew car registration" })).toHaveCount(0);
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

test("quick capture starts Hermes with one tap and streams a reply", async ({ page }) => {
  await page.goto("/home");
  await page.getByLabel("Ask Hermes or capture something").fill("What is the weather?");
  await page.getByRole("button", { name: "Send to Hermes" }).click();
  await page.waitForURL(/\/chat\/.+/);
  await expect(page.getByText(/Searched the web/)).toBeVisible();
  await expect(page.getByText(/Here's what I found/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
});
