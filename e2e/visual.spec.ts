import { expect, test, type Page } from "@playwright/test";
import { ensureWorkflowActive, expectNoHorizontalOverflow, mock, openChatContext, setHa, startConversation } from "./helpers";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";
import { homePulseVisual, homeVisual } from "./fixtures/home";
import {
  alertsVisual,
  areaDetailVisual,
  areasVisual,
  chatVisual,
  chatWorkVisual,
  inboxVisual,
  itemDetailVisual,
  projectDetailVisual,
  visualNow,
} from "./fixtures/chat-alerts";
import { chatFilesVisual, filesVisual, PHOTO_PNG } from "./fixtures/chat-files";
import { MARKDOWN_FIXTURE } from "../lib/markdown-fixture";
import { forceSourceState, SOURCE_STATES } from "./fixtures/states";

/**
 * Visual snapshots of primary screens. Dynamic text (times, relative dates)
 * is masked. Update with: npm run test:e2e -- --update-snapshots
 */
test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
  await setHa(request, "cover.garage_door", "open", 45);
});

const MASK = ["time", "[data-dynamic]", "p.text-xs", "p.text-sm.text-muted", "header p.text-sm"];

/**
 * Freeze the browser clock at 12:00 America/Chicago on today's frame date. The server and the mock
 * upstreams date their seeds in the same timezone (mock-upstreams/util.mjs isoDate), so "Due today",
 * "N days overdue" and similar relative labels agree at any wall-clock time (no evening drift).
 */
async function freezeMiddayCT(page: Page) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  // 17:00 UTC is 12:00 CDT / 11:00 CST: midday either way, far from both date boundaries.
  // Never freeze AHEAD of the real clock: server data carries real fetchedAt/staleAfter (todos go
  // stale after 5 min), so a browser clock hours in the future shows "Last updated N hours ago" on
  // every card and rewraps rows (CI before ~noon CT). Same CT date either way, so relative day
  // labels ("Due today", "N days ago") don't change.
  const midday = Date.parse(`${ymd}T17:00:00.000Z`);
  await page.clock.setFixedTime(new Date(Math.min(Date.now(), midday)));
}

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
      await page.route(/\/api\/home\/pulse(?:\?.*)?$/, (route) => route.fulfill({ json: homePulseVisual }));
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
      // First-message time divider + the two (tap-to-reveal) message meta times.
      await expect(page.getByText("8:15 AM", { exact: true })).toHaveCount(3);
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
  await freezeMiddayCT(page);
  await page.goto("/home");
  expect((await page.request.delete("/api/home/tuning", { data: { scope: "all" }, headers: { "x-jarvis-csrf": "1" } })).ok()).toBe(true);
  await page.reload();
  const assists = page.locator("section[aria-labelledby=assist-h]");
  await assists.waitFor();
  await page.waitForTimeout(500);
  // The seasonal card is calendar-windowed on the server (Christmas: Nov 1 – Dec 20),
  // so it would flip this baseline twice a year; it has its own unit tests.
  await assists.locator("article", { hasText: "Seasonal idea" }).evaluateAll((els) => els.forEach((e) => ((e as HTMLElement).style.display = "none")));
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

// Workflows gallery (W1): one draft + one active user workflow and the built-ins, light and dark.
const workflowsVisual = {
  workflows: [
    {
      id: "wf_v1",
      slug: "teaching",
      name: "Teaching notes",
      icon: "book-open",
      hue: "lab",
      status: "active",
      currentVersion: 3,
      area: "Faith",
      areaId: null,
      description: "Live sermon/teaching notes: Scripture, points, quotes, reflections.",
      triggers: ["/teaching", "share", "areaPage"],
      builtIn: false,
      updatedAt: "2026-11-01T17:00:00.000Z",
    },
    {
      id: "wf_v2",
      slug: "bugtriage",
      name: "Bug triage",
      icon: "bug",
      hue: null,
      status: "draft",
      currentVersion: 1,
      area: "Work/Jarvis",
      areaId: null,
      description: "Reproduce, classify and file a bug.",
      triggers: ["/bugtriage"],
      builtIn: false,
      updatedAt: "2026-11-01T16:00:00.000Z",
    },
  ],
  builtIns: [
    {
      kind: "brief",
      slug: "brief",
      name: "Morning brief",
      description: "Today's priorities, calendar and approvals in one card.",
      href: "/home",
      builtIn: true,
    },
    { kind: "week", slug: "week", name: "Week plan", description: "Plan the week and block time on the calendar (asks first).", href: "/home", builtIn: true },
    { kind: "pr", slug: "pr", name: "PR review card", description: "A pull request's status, checks and review notes.", href: "/areas", builtIn: true },
  ],
};
for (const scheme of ["light", "dark"] as const) {
  test(`visual: workflows gallery (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await page.route(/\/api\/workflows(?:\?.*)?$/, (route) => route.fulfill({ json: workflowsVisual }));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.goto("/workflows");
    await expect(page.getByTestId("workflow-card")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page).toHaveScreenshot(`workflows-${scheme}.png`, { fullPage: true });
  });
}

// Workflows W2: start form (with the Place field) and the live Run panel. Real server data from a fixed
// definition; every list the pages fetch is stubbed and smart-default dates/times are masked.
const visNotes = { ...teaching, slug: "visnotes", name: "Visual notebook", triggers: [{ kind: "palette", command: "/visnotes" }] };
for (const scheme of ["light", "dark"] as const) {
  test(`visual: workflow start form and run panel (${scheme})`, async ({ page }) => {
    await ensureWorkflowActive(page, visNotes);
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [] } }));
    await page.goto("/workflows");
    const form = page.getByRole("dialog", { name: "New session" });
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("jarvis:workflow-start", { detail: { command: "/visnotes Ann Lyle John 15" } })));
      await expect(form).toBeVisible({ timeout: 2000 });
    }).toPass();
    await expect(form.getByLabel("Speaker")).toHaveValue("Ann Lyle");
    const masks = [...MASK, 'input[type="date"]', 'input[type="time"]', 'input[type="datetime-local"]'].map((m) => form.locator(m));
    await expect(form).toHaveScreenshot(`workflow-start-${scheme}.png`, { animations: "disabled", mask: masks });
    await form.getByTestId("workflow-start-submit").click();
    await expect(page).toHaveURL(/\/chat\//);
    const panel = page.getByTestId("workflow-run");
    await expect(panel.getByTestId("workflow-outline")).toContainText("John 15");
    // The chat auto-scrolls after the first run lands; wait until the page scroll and the panel box settle,
    // or the element shot catches the dock mid-scroll (mobile-320 light flaked with the composer over the panel).
    let last = "";
    await expect
      .poll(
        async () => {
          const box = await panel.boundingBox();
          const now = JSON.stringify([box, await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)]);
          const settled = now === last;
          last = now;
          return settled;
        },
        { intervals: [300], timeout: 10_000 },
      )
      .toBe(true);
    // The fixed composer and phone bottom nav paint over a tall panel at 320 px (and which one shows depends on
    // the keyboard/focus state), so hide them for the element shot: the baseline is the panel alone.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const hideOverlays = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock { visibility: hidden !important; }' });
    await expect(panel).toHaveScreenshot(`workflow-run-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => panel.locator(m)) });
    await hideOverlays.evaluate((el) => (el as Element).remove());
    await panel.getByRole("button", { name: "End session" }).click();
    await expect(panel).toContainText("Ended");
  });
}

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

// Dark theme of the chat thread (DS kit tokens: s3 user bubble, mono tool rows, composer box).
test("visual: chat (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.clock.setFixedTime(new Date(visualNow));
  const timeline = [...chatVisual.timeline, { kind: "assistant" as const, id: "visual-markdown", text: MARKDOWN_FIXTURE, at: visualNow }];
  await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
  await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: { ...chatVisual, timeline } }));
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
  await page.goto("/chat/sess_morning");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.getByText(chatVisual.timeline[2].text!, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot("chat-dark.png", { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
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

// PR10 approval card (agent mark, mono command, Approve/Deny), light + dark.
for (const theme of ["light", "dark"] as const) {
  test(`visual: approval card (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await startConversation(page, "please delete the build folder");
    if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("rm -rf build");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.waitForTimeout(300);
    await expect(card).toHaveScreenshot(`approval-card-${theme}.png`, { animations: "disabled" });
    // Resolve it so the pending request doesn't leak into other specs' screenshots.
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card).toBeHidden({ timeout: 15_000 });
  });
}

// Smart UI kit (PR9): a proposed-changes surface with one staged row, light and dark.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: smart surface (${scheme})`, async ({ page, request }) => {
    await mock(request, "/google/tasks", {
      tasks: [
        { title: "Visualsmart gutter clean", dueDays: -4 },
        { title: "Visualsmart library book", dueDays: -5 },
      ],
    });
    const put = (path: string, data: unknown) => page.request.put(path, { data, headers: { "x-jarvis-csrf": "1" } });
    const post = async (path: string, data: unknown) => {
      const res = await page.request.post(path, { data, headers: { "x-jarvis-csrf": "1" } });
      expect(res.ok(), await res.text()).toBeTruthy();
      return res.json();
    };
    await put("/api/smart/settings", { enabled: true });
    await freezeMiddayCT(page);
    try {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/todos");
      await expect(page.getByText("Visualsmart gutter clean").first()).toBeVisible({ timeout: 15_000 });
      const { id } = (await post("/api/hermes/sessions", { title: `Visualsmart ${scheme}` })) as { id: string };
      await post(`/api/hermes/sessions/${encodeURIComponent(id)}/runs`, {
        input: "Help me triage my overdue tasks",
        idempotencyKey: `visualsmart-${scheme}-${Date.now()}`,
        context: "@ctx:overdue_todos",
        capabilities: ["jarvis-ui@1"],
      });
      await page.goto(`/chat/${encodeURIComponent(id)}`);
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      const surface = page.getByTestId("smart-surface").first();
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.getByRole("button", { name: "Drop: Visualsmart library book" }).click();
      await expect(surface.getByTestId("smart-tray-count")).toHaveText("1 change staged");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.waitForTimeout(500);
      await expect(surface).toHaveScreenshot(`smart-surface-${scheme}.png`, { mask: MASK.map((m) => page.locator(m)) });
    } finally {
      await put("/api/smart/settings", { enabled: false });
    }
  });
}

// PR11 slices 3–4: Settings, Tasks, House, People and Workouts pages, light + dark (viewport only).
for (const [name, path] of [
  ["settings", "/settings"],
  ["todos", "/todos"],
  ["house", "/home-control"],
  ["people", "/settings/people"],
  ["workouts", "/workouts"],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`visual: ${name} page (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      if (name === "todos" || name === "house") await freezeMiddayCT(page);
      if (name === "people") {
        // Other specs add people to the shared DB: show only the owner, with a fixed join date.
        await page.route(/\/api\/people$/, async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const res = await route.fetch();
          const body = (await res.json()) as { people: { owner: boolean; createdAt: string }[] };
          const people = body.people.filter((p) => p.owner).map((p) => ({ ...p, createdAt: "2026-01-01T12:00:00.000Z" }));
          await route.fulfill({ json: { ...body, people } });
        });
      }
      if (name === "workouts") await page.route(/\/api\/workouts$/, (route) => route.fulfill({ json: { workouts: [] } }));
      await page.goto(path);
      await page.locator("h1").first().waitFor();
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      if (name === "house") {
        // Exception detail ("Open for N min … since h:mm") is masked but its length varies with the clock,
        // which changes wrapping and shifts everything below: keep it on one line for the snapshot.
        await page.addStyleTag({ content: "li.card p.text-sm.text-muted { white-space: nowrap; overflow: hidden; }" });
      }
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
    });
  }
}

// PR12 states: per-source error banner and not-connected empty state, light + dark.
for (const name of Object.keys(SOURCE_STATES) as (keyof typeof SOURCE_STATES)[]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`visual: state ${name} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const path = await forceSourceState(page, name);
      await page.goto(path);
      await page.locator("h1").first().waitFor();
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`state-${name}-${scheme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
    });
  }
}

// CH-R1: the per-turn work summary, collapsed (failed step stays visible) and expanded, light + dark.
for (const theme of ["light", "dark"] as const) {
  test(`visual: chat work summary (${theme})`, async ({ page }) => {
    if (theme === "dark") await page.emulateMedia({ colorScheme: "dark" });
    await page.clock.setFixedTime(new Date(visualNow));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: chatWorkVisual }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.goto("/chat/sess_morning");
    if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const work = page.locator(".chat-work").first();
    const head = work.getByRole("button", { name: /Worked for 13s · searched 1 source, ran 1 command, browsed 1 page, read 1 file · 1 failed/ });
    await expect(head).toHaveAttribute("aria-expanded", "false");
    // Collapsed: only the failed step shows, with its duration and status.
    await expect(work.locator(".chat-tool")).toHaveCount(1);
    await expect(work.locator(".chat-tool")).toContainText("1s · failed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(work).toHaveScreenshot(`chat-work-collapsed-${theme}.png`, { animations: "disabled" });
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(work.locator(".chat-tool")).toHaveCount(4);
    await expect(work.locator(".chat-tool").nth(1)).toContainText("6s · done");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(work).toHaveScreenshot(`chat-work-expanded-${theme}.png`, { animations: "disabled" });
  });
}

// Tide orb (v0 "Tide with Lagoon text", Playful): phone bar orb + open radial at 390, desktop dock orb at 1440.
async function orbClip(page: import("@playwright/test").Page, pad = 28) {
  const b = (await page.locator('[data-testid="dock-orb"]:visible').boundingBox())!;
  const vp = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) };
}
const TIDE_O1 = "rgb(59, 128, 112)";
for (const theme of ["light", "dark"] as const) {
  test(`visual: tide orb phone bar + radial (${theme})`, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "phone bar orb is shot once at 390");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/more");
    await page.locator("h1").first().waitFor();
    if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const orb = page.locator('[data-testid="dock-orb"]:visible');
    await expect(orb).toBeVisible();
    const look = await orb.evaluate((el) => {
      const cs = getComputedStyle(el);
      const g = el.querySelector(".k-orb-g")!;
      return { bg: cs.backgroundImage, anim: cs.animationName, glyph: getComputedStyle(g).animationName, svg: el.querySelector("svg path") !== null };
    });
    expect(look.bg).toContain(TIDE_O1);
    expect(look.anim).toBe("k-flow");
    expect(look.glyph).toBe("k-twinkle");
    await expect(page).toHaveScreenshot(`tide-orb-bar-${theme}.png`, { clip: await orbClip(page) });
    await orb.focus();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator('#command-map [data-petal="search"]')).toBeVisible();
    await expect(orb).toHaveAttribute("aria-expanded", "true");
    expect(await orb.evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("paused");
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`tide-orb-radial-${theme}.png`, { mask: [page.locator('[role="status"]')] });
    await page.keyboard.press("Escape");
  });
}
test("visual: tide orb desktop dock (1440)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop dock orb");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/more");
  await page.locator("h1").first().waitFor();
  const dot = page.locator('[data-testid="dock-orb"]:visible .dock-orb');
  await expect(dot).toBeVisible();
  const look = await dot.evaluate((el) => ({ bg: getComputedStyle(el).backgroundImage, anim: getComputedStyle(el).animationName }));
  expect(look.bg).toContain(TIDE_O1);
  expect(look.bg).not.toContain("107, 63, 196");
  expect(look.anim).toBe("k-flow");
  await expect(page).toHaveScreenshot("tide-orb-desktop.png", { clip: await orbClip(page, 16) });
});
test("tide orb: reduced motion stops flow, aura and twinkle", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "computed-style check, once");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/more");
  const orb = page.locator('[data-testid="dock-orb"]:visible');
  await expect(orb).toBeVisible();
  const r = await orb.evaluate((el) => ({
    orb: getComputedStyle(el).animationName,
    aura: getComputedStyle(el.querySelector(".k-orb-aura")!).display,
    glyph: getComputedStyle(el.querySelector(".k-orb-g")!).animationName,
  }));
  expect(r).toEqual({ orb: "none", aura: "none", glyph: "none" });
  await expect(page).toHaveScreenshot("tide-orb-bar-reduced.png", { clip: await orbClip(page) });
});

// CH-CX1/CH-CX3: Add-context sheet and the Links panel (≥1100 px column, phone dialog), light + dark.
const LINKS_VISUAL = [
  {
    url: "https://artifacts.ai.nickbolles.com/v/visual-board/",
    kind: "artifact",
    domain: "artifacts.ai.nickbolles.com",
    title: "Visual board",
    slug: "visual-board",
    pinned: true,
  },
  {
    url: "https://github.com/NickBolles/Personal-dashboard/pull/72",
    kind: "github",
    domain: "github.com",
    title: "Chat context sheet",
    repo: "NickBolles/Personal-dashboard",
    number: 72,
    ghType: "pull",
    state: "open",
    pinned: false,
  },
  { url: "https://example.com/notes", kind: "web", domain: "example.com", title: "Release notes", pinned: false },
];
for (const theme of ["light", "dark"] as const) {
  test(`visual: chat context sheet + links (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.setFixedTime(new Date(visualNow));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: chatVisual }));
    await page.route(/\/api\/hermes\/sessions\/sess_morning\/links-panel$/, (route) => route.fulfill({ json: { links: LINKS_VISUAL } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.goto("/chat/sess_morning");
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await expect(page.getByText(chatVisual.timeline[2].text!, { exact: true })).toBeVisible();
    const wide = (page.viewportSize()?.width ?? 0) >= 1100;
    const panel = wide ? page.getByRole("complementary", { name: "Context and links" }) : page.getByRole("dialog", { name: "Context & links" });
    if (!wide) await page.getByTestId("links-button").click();
    await expect(panel.locator('[data-kind="artifact"]')).toHaveCount(1);
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`chat-links-${theme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
    if (!wide) await page.keyboard.press("Escape");
    await openChatContext(page);
    const sheet = page.getByRole("dialog", { name: "Add context" });
    await expect(sheet.getByRole("combobox", { name: "Search context" })).toBeFocused();
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`chat-context-sheet-${theme}.png`, { fullPage: false, mask: [...MASK, "[role=listbox]"].map((m) => page.locator(m)) });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`visual: chat files and pictures (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.clock.setFixedTime(new Date(visualNow));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/hermes\/sessions\/sess_files$/, (route) => route.fulfill({ json: chatFilesVisual }));
    await page.route(/\/api\/hermes\/sessions\/sess_files\/links-panel$/, (route) => route.fulfill({ json: { links: [] } }));
    await page.route(/\/api\/hermes\/sessions\/sess_files\/files\/[^/?]+(\?thumb=1)?$/, (route) =>
      route.fulfill({ body: PHOTO_PNG, contentType: "image/png" }),
    );
    // List: the sent files. Upload: the picture is ready at once, the PDF stays in flight (progress chip).
    await page.route(/\/api\/hermes\/sessions\/sess_files\/files$/, async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { files: filesVisual } });
      if ((route.request().postData() ?? "").includes("plan.pdf")) return; // never answers: stays uploading
      return route.fulfill({ json: { file: { ...filesVisual[0], id: "cf_visual_draft1", name: "corner.png", sentAt: null } } });
    });
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.goto("/chat/sess_files");
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await expect(page.getByText(chatFilesVisual.timeline[1].text, { exact: true })).toBeVisible();
    await page.getByTestId("chat-file-input").setInputFiles([
      { name: "corner.png", mimeType: "image/png", buffer: PHOTO_PNG },
      { name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%visual\n") },
    ]);
    await expect(page.getByTestId("attachment-chip").first()).toHaveAttribute("data-status", "ready");
    await expect(page.getByTestId("attachment-chip").nth(1)).toHaveAttribute("data-status", "uploading");
    await page.waitForTimeout(600);
    const mask = [...MASK, "[role=progressbar]"].map((m) => page.locator(m));
    await expect(page).toHaveScreenshot(`chat-files-${theme}.png`, { fullPage: false, mask });
    const wide = (page.viewportSize()?.width ?? 0) >= 1100;
    const panel = wide ? page.getByRole("complementary", { name: "Context and links" }) : page.getByRole("dialog", { name: "Context & links" });
    if (!wide) await page.getByTestId("links-button").click();
    await expect(panel.getByText("shelf-measurements.txt")).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`chat-files-panel-${theme}.png`, { fullPage: false, mask });
  });
}

// Inbox as its own view (/inbox): fixed entries (one with a suggestion) so other specs' captures never leak in.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: inbox page (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.clock.setFixedTime(new Date(visualNow));
    const capture = (suggested: boolean) => ({
      channel: null,
      triageState: "done",
      triageSkipReason: null,
      suggestedTitle: null,
      suggestedKind: null,
      suggestion: suggested ? { parentId: "wk_mb", title: "Momentum Bets", path: "Momentum Bets", confidence: 0.82, reason: "Mentions the bet review" } : null,
      sensitivity: "none",
      report: null,
      attachments: [],
      investigating: false,
    });
    const items = [
      {
        id: "inb_v1",
        source: "capture",
        title: "Review the momentum bet notes",
        note: "",
        url: null,
        repo: null,
        number: null,
        reason: "Quick capture",
        createdAt: visualNow,
        capture: capture(true),
      },
      {
        id: "inb_v2",
        source: "capture",
        title: "Call the plumber about the garage sink",
        note: "",
        url: null,
        repo: null,
        number: null,
        reason: "Quick capture",
        createdAt: visualNow,
        capture: capture(false),
      },
    ];
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { items, conversations: [], conversationsTotal: 0, unavailable: [], count: items.length } }),
    );
    // "Unfiled conversations" (components/work/conversations.tsx UnfiledPanel) reads its own list: stub it too,
    // or chats created by other specs in the shared DB leak into the snapshot.
    const unfiled = {
      conversations: [
        {
          id: "sess_inbox_v1",
          title: "Garage sink quotes",
          preview: "Two plumbers can come next week",
          lastActiveAt: visualNow,
          backend: "hermes",
          readOnly: false,
          linkedItems: [],
          placement: null,
          shared: false,
          suggestions: [],
        },
      ],
      total: 1,
      unavailable: [],
      updating: false,
      cachedAt: visualNow,
    };
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: unfiled }));
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await expect(page.getByText(items[0].title).first()).toBeVisible();
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page).toHaveScreenshot(`inbox-${scheme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
  });
}

/** Raycast palette (PR #102): stub every list the palette loads so other specs' data never leaks in. */
async function openPaletteVisual(page: Page) {
  await freezeMiddayCT(page);
  await page.route(/\/api\/search(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        query: "",
        partial: [],
        results: [
          {
            id: "r1",
            kind: "work",
            module: "jarvis",
            title: "V5 evaluator contract",
            subtitle: "Momentum Bets › Criteria evaluator",
            href: "/areas?item=wk_v5",
            group: "Recent",
          },
          { id: "r2", kind: "work", module: "jarvis", title: "Criteria evaluator", subtitle: "Momentum Bets", href: "/areas?item=wk_ce", group: "Recent" },
        ],
      },
    }),
  );
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
  await page.addInitScript(() => localStorage.removeItem("jarvis.palette.recent"));
  await page.goto("/more");
  await page.locator("h1").first().waitFor();
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(box).toBeFocused({ timeout: 1000 });
  }).toPass();
  await expect(page.getByRole("option", { name: /Browse areas/ })).toBeVisible();
  return box;
}
for (const theme of ["light", "dark"] as const) {
  test(`visual: raycast palette (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const box = await openPaletteVisual(page);
    if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot(`palette-root-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) });
    // typed action with an argument chip
    await box.fill("new item in momentum bets");
    await expect(page.locator('[data-command="action.new-item"]')).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("palette-chips")).toContainText("Momentum Bets");
    await box.fill("Gutter sweep");
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot(`palette-typed-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-confirm")).toBeVisible();
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot(`palette-confirm-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) });
    await page.keyboard.press("Escape");
  });
}

// Inline edits: the item detail header read view and the title editor, light + dark.
for (const theme of ["light", "dark"] as const) {
  test(`visual: inline edits (${theme})`, async ({ page }) => {
    await freezeMiddayCT(page);
    await page.emulateMedia({ colorScheme: theme });
    const d = itemDetailVisual;
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(new RegExp(`/api/work/items/${d.item.id}$`), (route) => route.fulfill({ json: d }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    await page.goto(`/areas?item=${d.item.id}`);
    if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const header = page.locator('article[aria-labelledby="work-item-title"] > section').first();
    await expect(page.locator("#work-item-title")).toHaveText(d.item.title);
    await page.waitForTimeout(500);
    await expect(header).toHaveScreenshot(`inline-read-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) });
    await page.locator("#work-item-title").getByRole("button").click();
    await expect(page.getByRole("textbox", { name: "Edit title" })).toBeFocused();
    await page.waitForTimeout(150);
    await expect(header).toHaveScreenshot(`inline-title-edit-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) });
    await page.keyboard.press("Escape");
  });
}

/** Activity timeline (/areas/activity): stub the feed and every list the shell loads. */
for (const scheme of ["light", "dark"] as const) {
  test(`visual: activity timeline (${scheme})`, async ({ page }) => {
    await freezeMiddayCT(page);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const at = (dayOffset: number, hourUtc: number) =>
      new Date(Date.parse(`${ymd}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`) + dayOffset * 86_400_000).toISOString();
    const obj = (id: string, title: string) => ({ id, title });
    const items = [
      {
        id: "a1",
        at: at(0, 16),
        type: "edit",
        actor: { kind: "you", name: "You" },
        verb: "edited summary",
        object: obj("wk_v5", "V5 evaluator contract"),
        detail: null,
        undoOpId: "op1",
      },
      {
        id: "a2",
        at: at(0, 15),
        type: "chat",
        actor: { kind: "agent", name: "Hermes" },
        verb: "replied in",
        object: obj("wk_c1", "Gutter quotes"),
        detail: null,
        undoOpId: null,
      },
      {
        id: "a3",
        at: at(0, 14),
        type: "status",
        actor: { kind: "you", name: "You" },
        verb: "moved to In review",
        object: obj("wk_v5", "V5 evaluator contract"),
        detail: "In progress → In review",
        undoOpId: null,
      },
      {
        id: "a4",
        at: at(-1, 20),
        type: "github",
        actor: { kind: "github", name: "GitHub" },
        verb: "PR merged on",
        object: obj("wk_ce", "Criteria evaluator"),
        detail: "#412",
        undoOpId: null,
      },
      {
        id: "a5",
        at: at(-1, 18),
        type: "capture",
        actor: { kind: "you", name: "You" },
        verb: "filed a capture into",
        object: obj("wk_home", "Home"),
        detail: "Replace furnace filter",
        undoOpId: null,
      },
      {
        id: "a6",
        at: at(-3, 17),
        type: "created",
        actor: { kind: "you", name: "You" },
        verb: "created",
        object: obj("wk_ce", "Criteria evaluator"),
        detail: null,
        undoOpId: null,
      },
    ];
    await page.route(/\/api\/work\/activity(?:\?.*)?$/, (route) => route.fulfill({ json: { items, nextCursor: "c1", latestAt: items[0].at } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    await page.goto("/areas/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await expect(page.getByText("Replace furnace filter")).toBeVisible();
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.waitForTimeout(500);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot(`activity-${scheme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
  });
}
