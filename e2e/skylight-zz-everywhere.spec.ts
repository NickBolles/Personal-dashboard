/**
 * Skylight everywhere (owner request 2026-11-07): chores complete in place on Today, in the Chief of staff tray card
 * and by swipe on phones, all through the confirm card + Undo, with motion that collapses to instant under
 * prefers-reduced-motion. Runs on the strict Skylight mock only — nothing is written to real Skylight.
 */
import { expect, test, type Page } from "@playwright/test";
import { MOCK_URL, mock } from "./helpers";
import { addDays, localDate } from "../lib/time";
import { prismWeekly } from "./fixtures/smart-v2";

const H = { "x-jarvis-csrf": "1" };
type Write = { method: string; path: string; body: Record<string, unknown> };
let previous: { enabled: boolean; config: Record<string, string> } | undefined;
const today = () => localDate(new Date(), "America/Chicago");

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
/** Seed chores in the strict mock (frame-local dates) and resync the source. */
async function addChores(page: Page, chores: Record<string, unknown>[]) {
  for (const c of chores) {
    const r = await page.request.post(`${MOCK_URL}/__mock/skylight/chores`, { data: c });
    expect(r.ok(), await r.text()).toBe(true);
  }
  expect((await page.request.get("/api/sources/skylight?refresh=1")).ok()).toBe(true);
}
const completions = async (page: Page, id: string) =>
  (await writes(page)).filter((w) => w.method === "PUT" && w.path.endsWith(`/chores/${id}/completions`)).map((w) => w.body.status);

// 12 writes/min per user (integrations/skylight/write.ts) are shared with the skylight-write* specs that run just
// before this file: start with a fresh budget so Undo is never rate limited.
test.beforeAll(async () => {
  test.setTimeout(90_000);
  await new Promise((resolve) => setTimeout(resolve, 61_000));
});

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
  const refreshed = await page.request.get("/api/sources/skylight");
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

test("skyall: completes a chore from Today with motion, then Undo restores it", async ({ page }) => {
  await addChores(page, [{ id: "88355001", summary: "Skyall fold the towels", category: "13600771", start: today() }]);
  await page.goto("/home");
  const section = page.getByTestId("today-chores");
  const row = section.getByRole("article", { name: /Skyall fold the towels/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const anytime = section.getByRole("region", { name: /^Anytime/ });
  await expect(anytime.getByRole("img", { name: /^Anytime: 0 of \d+ done$/ })).toBeVisible();
  await row.getByRole("checkbox", { name: /Done: .*Skyall fold the towels/ }).click();
  await confirm(page, /Mark “.*Skyall fold the towels” done in Skylight/);
  await expect(anytime.getByRole("article", { name: /Skyall fold the towels/ })).toHaveCount(0);
  await expect(section.getByTestId("today-chores-done")).toContainText("Skyall fold the towels");
  await expect(anytime.getByRole("img", { name: /^Anytime: 1 of \d+ done$/ })).toBeVisible();
  await expect.poll(() => completions(page, "88355001")).toEqual(["complete"]);
  await undo(page);
  await expect(anytime.getByRole("article", { name: /Skyall fold the towels/ })).toBeVisible();
  await expect(anytime.getByRole("img", { name: /^Anytime: 0 of \d+ done$/ })).toBeVisible();
  await expect.poll(() => completions(page, "88355001")).toEqual(["complete", "pending"]);
});

test("skyall: completes a chore from the Chief of staff tray card", async ({ page }) => {
  await addChores(page, [{ id: "88355002", summary: "Skyall water the ferns", category: "13600771", start: today() }]);
  await page.route("**/api/smart/settings", (r) => r.fulfill({ json: { enabled: true, calendarWrites: false } }));
  const card = {
    ...prismWeekly,
    id: `chores:${today()}`,
    kind: "chores",
    action: "Open",
    line: { tone: "ok", dot: null, icon: "✓", label: "Chores", text: "0 of 1 done · 0 up for grabs" },
    footer: { label: "Open Skylight", href: "/skylight" },
  };
  await page.route("**/api/smart/dynamic*", (r) => r.fulfill({ json: { cards: [card], today: today() } }));
  // The tray's deep link opens the card (the same path a tapped "Chores" tray line takes).
  await page.goto(`/more?smartCard=${encodeURIComponent(card.id)}`);
  const chores = page.getByTestId("skylight-chores-card");
  const row = chores.getByRole("article", { name: /Skyall water the ferns/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("checkbox", { name: /Done: .*Skyall water the ferns/ }).click();
  await confirm(page, /Mark “.*Skyall water the ferns” done in Skylight/);
  await expect(chores.getByTestId("tray-chores-done")).toContainText("Skyall water the ferns");
  await expect.poll(() => completions(page, "88355002")).toEqual(["complete"]);
  await undo(page);
  await expect(chores.getByRole("region", { name: /^Anytime/ }).getByRole("article", { name: /Skyall water the ferns/ })).toBeVisible();
  await expect.poll(() => completions(page, "88355002")).toEqual(["complete", "pending"]);
});

test("skyall: swipe right on a phone completes through the confirm card", async ({ page }) => {
  await addChores(page, [{ id: "88355003", summary: "Skyall sweep the steps", category: "13600771", start: today() }]);
  await page.goto("/home");
  const row = page.getByTestId("today-chores").locator(".sk-row").filter({ hasText: "Skyall sweep the steps" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width * 0.35;
  const fire = (type: string, x: number) =>
    row.dispatchEvent(type, { pointerType: "touch", pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true });
  await fire("pointerdown", x0);
  for (const dx of [16, 40, 70, 96]) await fire("pointermove", x0 + dx);
  await fire("pointerup", x0 + 96);
  await confirm(page, /Mark “.*Skyall sweep the steps” done in Skylight/);
  await expect(page.getByTestId("today-chores-done")).toContainText("Skyall sweep the steps");
  await expect.poll(() => completions(page, "88355003")).toEqual(["complete"]);
  // A short drag springs back without asking.
  await addChores(page, [{ id: "88355004", summary: "Skyall stack the logs", category: "13600771", start: today() }]);
  await page.reload();
  const other = page.getByTestId("today-chores").locator(".sk-row").filter({ hasText: "Skyall stack the logs" });
  await expect(other).toBeVisible({ timeout: 15_000 });
  const b2 = (await other.boundingBox())!;
  await other.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 8, isPrimary: true, clientX: b2.x + 100, clientY: b2.y + 10, bubbles: true });
  await other.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 8, isPrimary: true, clientX: b2.x + 140, clientY: b2.y + 10, bubbles: true });
  await other.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 8, isPrimary: true, clientX: b2.x + 140, clientY: b2.y + 10, bubbles: true });
  await expect(page.getByRole("dialog", { name: "Confirm Skylight change" })).toHaveCount(0);
});

test("skyall: reduced motion completes instantly with no animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addChores(page, [{ id: "88355005", summary: "Skyall empty the dryer", category: "13600771", start: addDays(today(), 0) }]);
  await page.goto("/home");
  const section = page.getByTestId("today-chores");
  const row = section.locator(".sk-row").filter({ hasText: "Skyall empty the dryer" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  expect(await row.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
  await row.getByRole("checkbox", { name: /Done: .*Skyall empty the dryer/ }).click();
  await confirm(page, /Skyall empty the dryer/);
  const done = section.getByTestId("today-chores-done").locator(".sk-row").filter({ hasText: "Skyall empty the dryer" });
  await expect(done).toBeAttached();
  expect(await done.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await expect.poll(() => completions(page, "88355005")).toEqual(["complete"]);
});
