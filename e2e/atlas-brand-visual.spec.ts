import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { forceSourceState } from "./fixtures/states";

const NOW = "2026-11-25T18:00:00.000Z";
async function fixtures(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
  const session = { id: "atlas-brand-fixture", title: "Chief of staff", pinned: false, archived: false };
  await page.route("**/api/work/coordinator/global", (r) =>
    r.fulfill({
      json: {
        area: { id: "atlas-fixture", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: session.id,
        sessionTitle: session.title,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route("**/api/work/decisions*", (r) => r.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (r) => r.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/coordinator/decisions*", (r) => r.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  const lastLooked = { chat: null, needs: null, running: null, changes: null, context: null };
  await page.route("**/api/coordinator/runs", (r) => r.fulfill({ json: { runs: [], events: [], lastLooked } }));
  await page.route("**/api/coordinator/looked", (r) => r.fulfill({ json: { lastLooked } }));
  await page.route("**/api/hermes/sessions**", (r) => {
    const p = new URL(r.request().url()).pathname;
    if (r.request().method() !== "GET") return r.fulfill({ status: 409, json: { error: "No sends in branding verification" } });
    if (p.endsWith("/area")) return r.fulfill({ json: { enabled: false } });
    if (p.endsWith("/execution"))
      return r.fulfill({ json: { sessionId: session.id, parent: null, records: [], sources: [{ source: "transcript", state: "ok" }], fetchedAt: NOW } });
    if (p.endsWith("/files") || p.endsWith("/links-panel")) return r.fulfill({ json: { files: [], links: [] } });
    if (p === "/api/hermes/sessions") return r.fulfill({ json: { sessions: [session], nextOffset: null } });
    return r.fulfill({
      json: {
        session,
        children: [],
        links: [],
        timeline: [
          { kind: "user", id: "atlas-u1", text: "What needs my attention?", at: NOW },
          { kind: "assistant", id: "atlas-a1", text: "Your reviews are up to date. You can pick the next task when you’re ready.", at: NOW },
        ],
      },
    });
  });
}
async function widthGuard(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `overflow at ${width}`).toBeLessThanOrEqual(width);
}
async function shot(page: Page, name: string) {
  const dir = process.env.ATLAS_EVIDENCE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), animations: "disabled" });
}

for (const theme of ["light", "dark"] as const) {
  test(`Atlas identity: error and unconnected states (${theme})`, async ({ page }, info) => {
    await fixtures(page);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const width = info.project.name === "desktop" ? 1440 : 320;
    await page.setViewportSize({ width, height: 900 });
    for (const state of ["todos-error", "skylight-unconfigured"] as const) {
      const route = await forceSourceState(page, state);
      await page.goto(route);
      await page.locator("h1").first().waitFor();
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await expect(page.getByText(state === "todos-error" ? "Upstream returned 502" : "Atlas doesn’t know this source’s state yet.").first()).toBeVisible();
      await widthGuard(page, width);
      await expect(page).toHaveTitle(/Atlas/);
      await shot(page, `after-${state}-${width}-${theme}`);
    }
  });
  test(`Atlas identity: responsive brand surfaces (${theme})`, async ({ page }, info) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await fixtures(page);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const widths = info.project.name === "desktop" ? [1440] : [320, 368, 412, 706];
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 706 ? 822 : 900 });
      for (const [route, label] of [
        ["/home", "home"],
        ["/settings", "settings"],
        ["/settings/agents", "agents"],
        ["/more", "install"],
        ["/offline", "offline"],
      ] as const) {
        await page.goto(route);
        await page.locator("h1").first().waitFor();
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await expect(page).toHaveTitle(/Atlas/);
        await widthGuard(page, width);
        if (route === "/settings") {
          await expect(page.getByTestId("atlas-about")).toContainText("Atlas: Thoughtful Life Assistant & Steward");
          await expect(page.getByTestId("atlas-about")).toContainText("Hermes is the agent runtime");
          await page.getByTestId("atlas-about").scrollIntoViewIfNeeded();
        }
        await shot(page, `after-${label}-${width}-${theme}`);
      }
      await page.goto("/home");
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      // Command/search palette, no upstream message sent.
      await expect(async () => {
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("combobox").first()).toBeFocused({ timeout: 1500 });
      }).toPass();
      await expect(page.getByRole("combobox").first()).toHaveAttribute("aria-label", "Search Atlas");
      await widthGuard(page, width);
      await shot(page, `after-palette-${width}-${theme}`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+.");
      await expect(page.getByRole("menu", { name: "Action map" })).toBeVisible();
      await widthGuard(page, width);
      await shot(page, `after-radial-${width}-${theme}`);
      await page.keyboard.press("Escape");
      if (width < 900) {
        await page.getByRole("button", { name: "Chief of staff", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Chief of staff" })).toBeVisible();
        await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("complementary", { name: "Chief of staff" })).toBeVisible();
      }
      await widthGuard(page, width);
      await shot(page, `after-coordinator-${width}-${theme}`);
      await page.keyboard.press("Escape");
      // Reflow audit includes the actual About copy and inherited mark, not a mock HTML specimen.
      await page.goto("/settings");
      await page.getByTestId("atlas-about").waitFor();
      await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
      await widthGuard(page, width);
      await shot(page, `after-settings-200pct-${width}-${theme}`);
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
    expect(errors).toEqual([]);
  });
}

test("Atlas login, offline and launch metadata preserve installation identity", async ({ browser, page, request }, info) => {
  const context = await browser.newContext({
    viewport: { width: info.project.name === "desktop" ? 1440 : 412, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  try {
    const login = await context.newPage();
    await login.goto(new URL("/login", page.url() === "about:blank" ? String(test.info().project.use.baseURL) : page.url()).href);
    await expect(login.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(login.locator("[data-atlas-mark]")).toBeVisible();
    await expect(login).toHaveTitle(/Atlas/);
    await shot(login, `after-login-${info.project.name}-dark`);
    const violations = (await new AxeBuilder({ page: login as never }).analyze()).violations;
    expect(violations).toEqual([]);
  } finally {
    await context.close();
  }
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect([m.name, m.short_name, m.id, m.start_url, m.scope]).toEqual(["Atlas", "Atlas", "/home", "/home?source=pwa", "/"]);
  for (const icon of m.icons) expect((await request.get(icon.src)).ok()).toBe(true);
});
