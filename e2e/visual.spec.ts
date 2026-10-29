import { expect, test } from "@playwright/test";
import { mock, setHa } from "./helpers";
import { homeVisual } from "./fixtures/home";
import { alertsVisual, areaDetailVisual, areasVisual, chatVisual, inboxVisual, projectDetailVisual, visualNow } from "./fixtures/chat-alerts";
import { MARKDOWN_FIXTURE } from "../lib/markdown-fixture";

/**
 * Visual snapshots of primary screens. Dynamic text (times, relative dates)
 * is masked. Update with: npm run test:e2e -- --update-snapshots
 */
test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
  await setHa(request, "cover.garage_door", "open", 45);
});

const MASK = ["time", "[data-dynamic]", "p.text-xs", "p.text-sm.text-muted", "header p.text-sm"];

for (const [name, path] of [
  ["home", "/home"],
  ["chat", "/chat/sess_morning"],
  ["alerts", "/alerts"],
  ["more", "/more"],
  ["kit", "/dev/kit"],
] as const) {
  test(`visual: ${name}`, async ({ page }) => {
    if (name === "home") {
      // /__mock/reset cannot undo Jarvis-owned Compass completion from pages.spec.
      // Isolate the visual contract, including cached/live reads, from that DB and
      // wall-clock freshness. Real provider/selector behavior is tested separately.
      await page.clock.setFixedTime(new Date(homeVisual.generatedAt));
      await page.route(/\/api\/home(?:\?.*)?$/, (route) => route.fulfill({ json: homeVisual }));
    }
    if (name === "chat" || name === "alerts") {
      await page.clock.setFixedTime(new Date(visualNow));
      await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    }
    if (name === "chat") {
      await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: chatVisual }));
      await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
      await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    }
    if (name === "alerts") {
      await page.route(/\/api\/notifications(?:\?.*)?$/, (route) => route.fulfill({ json: alertsVisual }));
    }
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    if (name === "chat") {
      await expect(page.getByText(chatVisual.timeline[2].text!, { exact: true })).toBeVisible();
      await expect(page.locator('header a[href^="/initiatives"]')).toHaveCount(0);
      await expect(page.getByText("8:15 AM", { exact: true })).toHaveCount(2);
    }
    if (name === "alerts") {
      await expect(page.locator("li[data-id] h2")).toHaveText(alertsVisual.notifications.map((n) => n.title));
      await expect(page.getByText("3 unread actionable", { exact: true })).toBeVisible();
    }
    if (name === "home") {
      await expect(page.locator("section[aria-labelledby=now-h] article h3")).toHaveText(homeVisual.now.map((a) => a.title));
      await expect(page.getByText("Last updated", { exact: false })).toHaveCount(0);
    }
    await page.waitForTimeout(800);
    await page.waitForTimeout(500);
    // Playwright also masks invisible matches. Hidden feedback paragraphs inside
    // closed disclosures can otherwise paint over unrelated card titles/badges.
    const masks = name === "home" ? MASK.map((m) => `${m}:visible`) : MASK;
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, mask: masks.map((m) => page.locator(m)) });
  });
}

test("visual: home suggestions and the backlog", async ({ page, request }) => {
  await mock(request, "/google/tasks", { tasks: Array.from({ length: 8 }, (_, i) => ({ title: `Overdue errand ${i + 1}`, dueDays: -(3 + i) })) });
  await page.goto("/home");
  expect((await page.request.delete("/api/home/tuning", { data: { scope: "all" }, headers: { "x-jarvis-csrf": "1" } })).ok()).toBe(true);
  await page.reload();
  const assists = page.locator("section[aria-labelledby=assist-h]");
  await assists.waitFor();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Seeded counts and relative dates are deterministic here; keep the grounding
  // copy and controls visible rather than masking every muted paragraph.
  await expect(assists).toHaveScreenshot("home-suggestions.png");
  await page.goto("/home/all?bucket=backlog");
  await page.locator("#all-items article").first().waitFor();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("home-all.png", { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
});

test("visual: workout builder and active capture", async ({ page }) => {
  await page.route(/\/api\/workouts$/, (route) => route.fulfill({ json: { workouts: [] } }));
  await page.goto("/workouts");
  await expect(page.getByRole("button", { name: "Start workout", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("workout-builder.png", { fullPage: true });
  await page.route(/\/api\/workouts$/, (route) =>
    route.fulfill({
      json: {
        workouts: [
          {
            id: "visual-session",
            version: 1,
            source: null,
            session: {
              date: "2026-01-10",
              title: "Legs + Push · 35 min",
              notes: "",
              status: "active",
              exercises: [
                {
                  name: "Leg press",
                  unit: "lb",
                  equipment: "machine",
                  sets: [
                    { weight: 30, reps: 8, done: true },
                    { weight: 30, reps: 8, done: false },
                    { weight: 30, reps: 8, done: false },
                  ],
                  best: { highest: { weight: 40, reps: 8, date: "2026-01-01" }, atLoad: { weight: 30, reps: 10, date: "2026-01-05" } },
                  target: { weight: 30, reps: 11 },
                },
              ],
            },
          },
        ],
      },
    }),
  );
  await page.reload();
  await expect(page.getByLabel("Leg press set 1 weight")).toHaveValue("30");
  for (const name of ["Save edits", "Finish workout", "Discard workout"]) {
    expect(await page.getByRole("button", { name, exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("workout-active.png", { fullPage: true });
});

test("visual: configuration transfer", async ({ page }) => {
  await page.goto("/settings/configuration");
  await expect(page.getByRole("heading", { name: "Configuration transfer" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot("configuration-transfer.png", { fullPage: true });
});

// Every Markdown element in one assistant message (fixture shared with test/markdown.test.tsx).
test("visual: markdown in a chat message", async ({ page }) => {
  await page.clock.setFixedTime(new Date(visualNow));
  const timeline = [...chatVisual.timeline, { kind: "assistant" as const, id: "visual-markdown", text: MARKDOWN_FIXTURE, at: visualNow }];
  await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
  await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: { ...chatVisual, timeline } }));
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
  await page.goto("/chat/sess_morning");
  const message = page.locator(".md").filter({ hasText: "Rollout plan" });
  await expect(message.getByRole("heading", { name: "Rollout plan" })).toBeVisible();
  await expect(message.getByRole("table")).toBeVisible();
  await expect(message.getByRole("button", { name: "Copy ts" })).toBeVisible();
  await expect(message.locator('a[href^="javascript"]')).toHaveCount(0);
  // A wide table scrolls inside its own box; the page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(300);
  await expect(message).toHaveScreenshot("markdown.png");
});

for (const [name, detail] of [
  ["area", areaDetailVisual],
  ["project", projectDetailVisual],
] as const) {
  test(`visual: ${name} page`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(visualNow));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(new RegExp(`/api/work/items/${detail.item.id}$`), (route) => route.fulfill({ json: detail }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.goto(`/areas?item=${detail.item.id}`);
    await expect(page.getByRole("heading", { level: 2, name: detail.item.title })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page).toHaveScreenshot(`${name}-page.png`, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
  });
}
