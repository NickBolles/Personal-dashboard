import { expect, test, type Page } from "@playwright/test";
import { ensureWorkflowActive, expectNoHorizontalOverflow, mock, openChatContext, openChatPanel, setHa, startConversation } from "./helpers";
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
import { mapDemo, mapDemoAreaDetail, mapDemoDecisions } from "./fixtures/map-demo";
import { agentRunsDemo, coordinatorDemo } from "./fixtures/agents-demo";
import { skylightGroupingVisual, skylightVisual, skylightWriteVisual } from "./fixtures/skylight";
import { noticesVisual } from "./fixtures/coordinator-chat";
import { phase3Coordinators, stubPhase3Settings } from "./fixtures/phase3-gaps";
import { openPrismChat, stubPrismV2 } from "./fixtures/smart-v2";
import { financeSnapshotFixture } from "../mock-upstreams/finance-snapshot.mjs";
import { awayFixture, schedulesFixture } from "./fixtures/away";
import { EMPTY_AWAY } from "../lib/client/away";
import { localDate } from "../lib/time";

/** Locator crops must not include fixed phone tray overlays; page shots retain them. */
async function withoutTray(page: Page, shoot: () => Promise<void>) {
  const t = await page.addStyleTag({ content: ".gc-tray, .gc-tray-qa { visibility: hidden !important; }" });
  try {
    await shoot();
  } finally {
    await t.evaluate((el) => (el as Element).remove());
  }
}

/**
 * Visual snapshots of primary screens. Dynamic text (times, relative dates)
 * is masked. Update with: npm run test:e2e -- --update-snapshots
 */
test.beforeEach(async ({ request, page }) => {
  await page.route("**/api/agents/away", (route) => route.fulfill({ json: EMPTY_AWAY }));
  await page.route("**/api/agents/schedules", (route) => route.fulfill({ json: schedulesFixture(localDate(new Date(), "America/Chicago")) }));
  await page.route(/\/api\/settings\/agents\/coordinators$/, (route) => route.fulfill({ json: phase3Coordinators }));
  await page.route("**/api/smart/dynamic", (route) => route.fulfill({ json: { cards: [], today: "2026-11-06" } }));
  // "Needs you" (Today, sidebar badge) would show other specs' open decisions: empty unless a test stubs it.
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  // Agent runs (map cards, Today rail, item panel) would show other specs' runs: empty unless a test stubs it.
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: {}, active: [] } }));
  // Global Chief of staff (rail/tray on every page): a fixed coordinator with no conversation, no
  // @chiefofstaff activity and no quick actions, so other specs' data never shows in any baseline.
  await page.route(/\/api\/work\/coordinator\/global(?:\?.*)?$/, (route) => route.fulfill({ json: globalCoordinatorVisual }));
  await page.route(/\/api\/work\/activity\?actor=agent&q=chiefofstaff/, (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route(/\/api\/quick-actions(?:\?.*)?$/, (route) => route.fulfill({ json: { actions: [] } }));
  await mock(request, "/reset");
  await setHa(request, "cover.garage_door", "open", 45);
});

const globalCoordinatorVisual = {
  area: { id: "gc_portfolio", title: "Portfolio" },
  scope: "global",
  agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed", from: { id: "gc_portfolio", title: "Portfolio" } },
  sessionId: null,
  sessionTitle: null,
  excluded: false,
  prompt: "Catch me up",
  lastRunAt: null,
};

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
  const frozen = Math.min(Date.now(), midday);
  await page.clock.setFixedTime(new Date(frozen));
  return frozen;
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
  await withoutTray(page, () => expect(assists).toHaveScreenshot("home-suggestions.png"));
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

// Workflows W3: builder (new, empty) and the Save-chat-as-workflow review with a fixed proposal.
const draftVisual = {
  proposal: {
    basics: { name: "Lantern study notes", slug: "lantern", icon: "book-open", description: "Notes from the lantern study group", area: null },
    instructions: "Keep each passage, the questions we asked, and my own takeaways separate. Use my words.",
    capture: { session: { type: "object", fields: { leader: "text?" } }, takeaways: { type: "list", of: "text" } },
    startForm: { title: "Start lantern study", fields: [{ id: "leader", bind: "session.leader", type: "person", label: "Leader" }] },
    rationale: "You repeat the same three-part structure every week.",
  },
};
for (const scheme of ["light", "dark"] as const) {
  for (const [name, path, ready] of [
    ["workflow-builder", "/workflows/new", "Builder sections"],
    ["workflow-review", "/workflows/new?fromChat=sess_visual", "Review the proposed workflow"],
  ] as const) {
    test(`visual: ${name} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await freezeMiddayCT(page);
      await page.route(/\/api\/workflows(?:\?.*)?$/, (route) => route.fulfill({ json: workflowsVisual }));
      await page.route(/\/api\/workflows\/draft$/, (route) => route.fulfill({ json: draftVisual }));
      await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
      await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
      await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
      await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [] } }));
      await page.goto(path);
      if (name === "workflow-builder") await page.getByRole("navigation", { name: ready }).waitFor();
      else await page.getByRole("heading", { name: ready }).waitFor();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const t = await page.addStyleTag({ content: 'nav[aria-label="Primary"].fixed, .chat-dock { visibility: hidden !important; }' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
      await t.evaluate((el) => (el as Element).remove());
    });
  }
}

// Workflows W4: workflow page (session history + stats + reminder) with fixed history (every list stubbed).
const historyVisual = {
  total: 3,
  rows: [
    {
      id: "r3",
      title: "a",
      status: "ended",
      date: "2026-10-25",
      place: "Heartland Sun Prairie",
      speaker: "Jake Fry",
      series: "Abide",
      scripture: "John 15:1–8",
      books: ["John"],
      counts: { points: 4, quotes: 2 },
      conversationId: null,
    },
    {
      id: "r2",
      title: "b",
      status: "ended",
      date: "2026-10-18",
      place: "Heartland Sun Prairie",
      speaker: "Ann Lyle",
      series: "Abide",
      scripture: "Psalms 23",
      books: ["Psalms"],
      counts: { points: 3, quotes: 1 },
      conversationId: null,
    },
    {
      id: "r1",
      title: "c",
      status: "ended",
      date: "2026-09-27",
      place: "Heartland Madison",
      speaker: "Jake Fry",
      series: "",
      scripture: "John 1:1–5",
      books: ["John"],
      counts: { points: 5, quotes: 0 },
      conversationId: null,
    },
  ],
  options: { speaker: ["Jake Fry", "Ann Lyle"], place: ["Heartland Sun Prairie", "Heartland Madison"], series: ["Abide"], book: ["John", "Psalms"] },
  stats: {
    total: 3,
    perMonth: ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"].map(
      (month) => ({
        month,
        count: month === "2026-10" ? 2 : month === "2026-09" ? 1 : 0,
      }),
    ),
    topBooks: [
      { label: "John", count: 2 },
      { label: "Psalms", count: 1 },
    ],
    topSpeakers: [
      { label: "Jake Fry", count: 2 },
      { label: "Ann Lyle", count: 1 },
    ],
  },
};
for (const scheme of ["light", "dark"] as const) {
  test(`visual: workflow page history and stats (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await page.route(/\/api\/workflows(?:\?.*)?$/, (route) => route.fulfill({ json: workflowsVisual }));
    await page.route(/\/api\/workflows\/wf_v1\/history(?:\?.*)?$/, (route) => route.fulfill({ json: historyVisual }));
    await page.route(/\/api\/workflows\/wf_v1\/reminder$/, (route) => route.fulfill({ json: { enabled: true, day: 0, time: "09:45", declared: true } }));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [] } }));
    await page.goto("/workflows/teaching");
    await expect(page.getByTestId("workflow-history")).toContainText("John 15:1–8");
    await expect(page.getByTestId("workflow-reminder").getByRole("switch")).toBeChecked();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: 'nav[aria-label="Primary"].fixed, .chat-dock { visibility: hidden !important; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page).toHaveScreenshot(`workflow-history-${scheme}.png`, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
    await t.evaluate((el) => (el as Element).remove());
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
    await withoutTray(page, () => expect(form).toHaveScreenshot(`workflow-start-${scheme}.png`, { animations: "disabled", mask: masks }));
    await form.getByTestId("workflow-start-submit").click();
    await expect(page).toHaveURL(/\/chat\//);
    const panel = page.getByTestId("workflow-run");
    await openChatPanel(page, "Outline");
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
    await withoutTray(page, () =>
      expect(panel).toHaveScreenshot(`workflow-run-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => panel.locator(m)) }),
    );
    await hideOverlays.evaluate((el) => (el as Element).remove());
    await panel.getByRole("button", { name: "End session" }).click();
    await page.getByRole("dialog", { name: "Before you go" }).getByTestId("workflow-end-submit").click();
    await expect(panel).toContainText("Ended");
  });
}

// #141/#142: Settings → Connections Google Drive + Offline Bible panels and inline verse text in the start form.
// Status + passage endpoints are stubbed with fixed fixtures (no real pack, no mock Drive state).
const visBible = { ...teaching, slug: "visbible", name: "Visual bible notebook", triggers: [{ kind: "palette", command: "/visbible" }] };
const passageVisual = {
  ref: "John 15:1–5",
  translation: "WEB",
  version: "2026-10-30",
  truncated: false,
  attribution: "World English Bible (WEB), public domain, from eBible.org.",
  verses: [
    { chapter: 15, verse: 1, text: "“I am the true vine, and my Father is the farmer." },
    {
      chapter: 15,
      verse: 2,
      text: "Every branch in me that doesn’t bear fruit, he takes away. Every branch that bears fruit, he prunes, that it may bear more fruit.",
    },
    { chapter: 15, verse: 3, text: "You are already pruned clean because of the word which I have spoken to you." },
    { chapter: 15, verse: 4, text: "Remain in me, and I in you." },
    { chapter: 15, verse: 5, text: "I am the vine. You are the branches." },
  ],
};
for (const scheme of ["light", "dark"] as const) {
  test(`visual: drive + offline bible settings and verse text (${scheme})`, async ({ page }) => {
    await ensureWorkflowActive(page, visBible);
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await page.route(/\/api\/integrations\/drive$/, (route) =>
      route.fulfill({
        json: {
          available: true,
          configured: true,
          connected: false,
          connectedAt: null,
          scope: "https://www.googleapis.com/auth/drive.file",
          redirectPath: "/api/integrations/drive/oauth/callback",
        },
      }),
    );
    await page.route(/\/api\/bible$/, (route) =>
      route.fulfill({
        json: {
          installed: true,
          name: "World English Bible",
          translation: "WEB",
          version: "2026-10-30",
          pinnedSha256: "0".repeat(64),
          sourceUrl: "https://ebible.org/Scriptures/engwebp_vpl.zip",
          downloadBytes: 4283563,
          installedAt: "2026-11-01T12:00:00.000Z",
          verses: 31098,
        },
      }),
    );
    await page.route(/\/api\/bible\/passage\?/, (route) => route.fulfill({ json: passageVisual }));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [] } }));
    await page.goto("/settings/connections#drive");
    const drive = page.locator("li#drive");
    await expect(drive.getByTestId("drive-connect")).toBeVisible();
    await withoutTray(page, () =>
      expect(drive).toHaveScreenshot(`connections-drive-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => drive.locator(m)) }),
    );
    await page.getByRole("button", { name: /Offline Bible/ }).click();
    const bible = page.locator("li#bible");
    await expect(bible.getByTestId("bible-installed")).toBeVisible();
    await withoutTray(page, () =>
      expect(bible).toHaveScreenshot(`connections-bible-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => bible.locator(m)) }),
    );

    await page.goto("/workflows");
    const form = page.getByRole("dialog", { name: "New session" });
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("jarvis:workflow-start", { detail: { command: "/visbible Ann Lyle John 15:1-5" } })));
      await expect(form).toBeVisible({ timeout: 2000 });
    }).toPass();
    const passage = form.getByTestId("scripture-passage");
    await expect(passage).toContainText("true vine");
    await withoutTray(page, () => expect(passage).toHaveScreenshot(`scripture-passage-${scheme}.png`, { animations: "disabled" }));
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
  await withoutTray(page, () => expect(message).toHaveScreenshot("markdown.png"));
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
    // The area page's project cards read the overview: stub it from the same items so other specs' data never leaks in.
    await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { items: areasVisual.items, links: {}, relations: {}, decisions: { count: 0, entries: [] } } }),
    );
    await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: {}, active: [] } }));
    await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: { count: 0, entries: [] } }));
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
    await withoutTray(page, () => expect(card).toHaveScreenshot(`approval-card-${theme}.png`, { animations: "disabled" }));
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
      await withoutTray(page, () => expect(surface).toHaveScreenshot(`smart-surface-${scheme}.png`, { mask: MASK.map((m) => page.locator(m)) }));
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
      // Todos merges Skylight chores: fixed fixture so the mock's clock-dependent chores never leak in.
      if (name === "todos") await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (route) => route.fulfill({ json: skylightVisual() }));
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
    await withoutTray(page, () => expect(work).toHaveScreenshot(`chat-work-collapsed-${theme}.png`, { animations: "disabled" }));
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(work.locator(".chat-tool")).toHaveCount(4);
    await expect(work.locator(".chat-tool").nth(1)).toContainText("6s · returned");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await withoutTray(page, () => expect(work).toHaveScreenshot(`chat-work-expanded-${theme}.png`, { animations: "disabled" }));
  });
}

// CH-R1 live state (#65): the streaming "Working" summary with its shimmer, from the kit gallery (deterministic).
for (const theme of ["light", "dark"] as const) {
  test(`visual: chat work summary live (${theme})`, async ({ page }) => {
    await page.goto("/dev/kit");
    const live = page.getByTestId(`kit-work-live-${theme}`).locator(".chat-work[data-live]");
    await expect(live.getByRole("button", { name: /^Working/ })).toBeVisible();
    await live.scrollIntoViewIfNeeded();
    await withoutTray(page, () => expect(live).toHaveScreenshot(`chat-work-live-${theme}.png`, { animations: "disabled" }));
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
    const panel = await openChatPanel(page, "Links");
    await expect(panel.locator('[data-kind="artifact"]')).toHaveCount(1);
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`chat-links-${theme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
    if (await page.getByRole("dialog", { name: "In this chat", exact: true }).isVisible()) await page.keyboard.press("Escape");
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
    const panel = await openChatPanel(page, "Files");
    await expect(panel.getByText("shelf-measurements.txt")).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`chat-files-panel-${theme}.png`, { fullPage: false, mask });
  });
}

// Coordinator chat: Hermes control frames as compact cards (delegation expanded + one task open), compaction divider open.
for (const theme of ["light", "dark"] as const) {
  test(`visual: chat notices (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await freezeMiddayCT(page);
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: 0 } }));
    await page.route(/\/api\/hermes\/sessions\/sess_notices$/, (route) => route.fulfill({ json: noticesVisual }));
    await page.route(/\/api\/hermes\/sessions\/sess_notices\/links-panel$/, (route) => route.fulfill({ json: { links: [] } }));
    await page.route(/\/api\/hermes\/sessions\/sess_notices\/files$/, (route) => route.fulfill({ json: { files: [] } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { conversations: [], total: 0, unavailable: [], updating: false } }),
    );
    await page.goto("/chat/sess_notices");
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const notice = page.getByTestId("chat-notice").filter({ hasText: "subagents finished" });
    await expect(notice).toBeVisible();
    await notice.locator("summary").first().click();
    await notice.getByTestId("notice-task").first().locator("summary").click();
    await page.getByText("Earlier conversation summarized").click();
    await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Sticky header / jump button / composer would paint over a timeline taller than the viewport.
    const t = await page.addStyleTag({
      content: 'nav[aria-label="Primary"], .chat-dock { visibility: hidden !important; } .sticky { position: static !important; }',
    });
    await page.waitForTimeout(600);
    const tl = page.getByLabel("Conversation timeline");
    await withoutTray(page, () => expect(tl).toHaveScreenshot(`chat-notices-${theme}.png`, { mask: MASK.map((m) => tl.locator(m)) }));
    await t.evaluate((el) => (el as Element).remove());
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
    await withoutTray(page, () => expect(header).toHaveScreenshot(`inline-read-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) }));
    await page.locator("#work-item-title").getByRole("button").click();
    await expect(page.getByRole("textbox", { name: "Edit title" })).toBeFocused();
    await page.waitForTimeout(150);
    await withoutTray(page, () => expect(header).toHaveScreenshot(`inline-title-edit-${theme}.png`, { mask: MASK.map((m) => page.locator(m)) }));
    await page.keyboard.press("Escape");
  });
}

// PR 3 delegated runs: the item Agent panel with a registered delegation (child summaries, copyable
// transcript path) and a Stalled run. Every list is stubbed; the clock is min(real, midday CT) and the
// runs are dated relative to it so "Stalled" is deterministic at any hour.
for (const theme of ["light", "dark"] as const) {
  test(`visual: agent delegation panel (${theme})`, async ({ page }) => {
    await freezeMiddayCT(page);
    await page.emulateMedia({ colorScheme: theme });
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const now = Math.min(Date.now(), Date.parse(`${ymd}T17:00:00.000Z`));
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    const d = itemDetailVisual;
    const base = { profile: "chiefofstaff", summary: null, prUrl: null, hermesSessionId: null, delegationId: null, transcriptPath: null, children: [] };
    const info = {
      itemId: d.item.id,
      areaId: "wk_home",
      title: d.item.title,
      who: { kind: "agent", name: "chiefofstaff" },
      live: "running",
      liveAt: ago(2),
      sessionId: null,
      runs: 2,
      prs: [],
      report: null,
      progress: null,
      agentRuns: [
        {
          ...base,
          id: "arun_v1",
          title: "Shelf bracket research",
          state: "running",
          summary: "Two of three sub-agents done.",
          delegationId: "deleg_shelf_01",
          transcriptPath: "/opt/data/delegations/deleg_shelf_01/transcript.md",
          children: [
            { title: "Bracket load ratings", state: "done", summary: "75 lb per pair on studs." },
            { title: "Stud finder check", state: "running", summary: null },
          ],
          startedAt: ago(20),
          updatedAt: ago(2),
        },
        { ...base, id: "arun_v2", title: "Paint colour options", state: "running", startedAt: ago(120), updatedAt: ago(90) },
      ],
    };
    await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: { [d.item.id]: info }, active: [info] } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(new RegExp(`/api/work/items/${d.item.id}$`), (route) => route.fulfill({ json: d }));
    await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: { ...mapDemo, items: areasVisual.items, links: {}, relations: {} } }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    await page.goto(`/areas?item=${d.item.id}`);
    const panel = page.getByTestId("item-agent-panel");
    await expect(panel.getByTestId("agent-run")).toHaveCount(2);
    if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await expect(panel.getByTestId("agent-run").nth(1).getByTestId("agent-stalled")).toHaveText("Stalled");
    await expect(panel.getByTestId("agent-run").first().getByTestId("agent-stalled")).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow(page);
    await withoutTray(page, () =>
      expect(panel).toHaveScreenshot(`agent-delegation-${theme}.png`, { animations: "disabled", mask: MASK.map((m) => panel.locator(m)) }),
    );
    await t.evaluate((el) => (el as Element).remove());
  });
}

// #111 tags + assignee: chips + filter on an area's list and the item header editor, light + dark.
// Every list the pages fetch is stubbed (tagged copy of areasVisual) so other specs' data never leaks in.
const taggedItems = {
  ...areasVisual,
  items: areasVisual.items.map((i) => (i.id === "wk_garage" ? { ...i, tags: ["shelving", "weekend"], assignee: "agent:devchief" } : i)),
};
const tagsVisual = {
  tags: [
    { name: "shelving", color: "ai", count: 1 },
    { name: "weekend", color: "ok", count: 1 },
  ],
  assignees: { agents: [{ ref: "agent:devchief", label: "@devchief", id: "devchief" }], people: [] },
};
for (const scheme of ["light", "dark"] as const) {
  test(`visual: item tags and chips (${scheme})`, async ({ page }) => {
    await freezeMiddayCT(page);
    await page.emulateMedia({ colorScheme: scheme });
    const garage = taggedItems.items.find((i) => i.id === "wk_garage")!;
    const home = { ...areaDetailVisual, item: taggedItems.items.find((i) => i.id === "wk_home")!, children: [garage] };
    const item = { ...itemDetailVisual, item: { ...itemDetailVisual.item, tags: garage.tags, assignee: garage.assignee } };
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: taggedItems }));
    await page.route(/\/api\/work\/items\/wk_home$/, (route) => route.fulfill({ json: home }));
    await page.route(/\/api\/work\/items\/wk_garage$/, (route) => route.fulfill({ json: item }));
    await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: { ...mapDemo, items: taggedItems.items, links: {}, relations: {} } }));
    await page.route(/\/api\/work\/tags(?:\?.*)?$/, (route) => route.fulfill({ json: tagsVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.goto("/areas?item=wk_home");
    if (scheme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    // Area page: loose items sit under the project cards (one list per level).
    const list = page.getByTestId("area-tree");
    const row = list.getByTestId("map-row").filter({ hasText: "Garage cleanup" });
    await expect(row.locator('[data-tag="weekend"]')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock { visibility: hidden !important; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await withoutTray(page, () => expect(list).toHaveScreenshot(`tags-list-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => list.locator(m)) }));
    await t.evaluate((el) => (el as Element).remove());

    await page.goto("/areas?item=wk_garage");
    if (scheme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await expect(page.locator('.jv-meta [data-tag="shelving"]')).toBeVisible();
    await expect(page.getByTestId("assignee-picker").getByRole("button")).toHaveAttribute("data-value", "agent:devchief");
    const header = page.locator('article[aria-labelledby="work-item-title"] > section').first();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t2 = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock { visibility: hidden !important; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await withoutTray(page, () =>
      expect(header).toHaveScreenshot(`tags-item-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => header.locator(m)) }),
    );
    await t2.evaluate((el) => (el as Element).remove());

    // the GitHub-label-style pickers: popover on desktop/tablet, bottom sheet on phones
    for (const [btn, name, file] of [
      ["Edit tags", "Tags", "tags-picker"],
      [/^Assignee/, "Assignee", "assignee-picker"],
      // N4: the status and due-date selects use the same picker (single-select list, no search ≤7 options)
      [/^Status:/, "Status", "status-picker"],
      [/^Due date:/, "Due date", "due-picker"],
    ] as const) {
      await page.getByRole("button", { name: btn }).click();
      const pop = page.getByRole("dialog", { name });
      await expect(pop.getByRole("option").first()).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const t3 = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock { visibility: hidden !important; }' });
      await withoutTray(page, () => expect(pop).toHaveScreenshot(`${file}-${scheme}.png`, { animations: "disabled" }));
      await t3.evaluate((el) => (el as Element).remove());
      await page.keyboard.press("Escape");
      if (await pop.isVisible())
        await page
          .locator(".jv-pick-scrim")
          .click({ force: true })
          .catch(() => {});
      await expect(pop).toBeHidden();
    }
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

/** Work from Jarvis: /map overview + drill-down and the Decisions inbox, from the demo fixture. */
for (const scheme of ["light", "dark"] as const) {
  for (const [name, path, h1] of [
    ["map", "/areas", "Areas"],
    ["decisions", "/decisions", "Needs you"],
  ] as const) {
    test(`visual: ${name} (${scheme})`, async ({ page }) => {
      await freezeMiddayCT(page);
      await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemo }));
      await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemoDecisions }));
      await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: agentRunsDemo }));
      await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
      await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
      await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
      await expect(page.getByText("Badge on the sidebar or the phone bar?").first()).toBeVisible();
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const t = await page.addStyleTag({
        content: 'nav[aria-label="Primary"].fixed, .chat-dock, .k-dock, [data-command-dock] { visibility: hidden !important; }',
      });
      await page.waitForTimeout(500);
      await expectNoHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
      await t.evaluate((el) => (el as Element).remove());
    });
  }
}

/** Work from Jarvis 2: the area coordinator pane (side pane on desktop, sheet on phones) after "Catch me up" (nothing sent). */
for (const scheme of ["light", "dark"] as const) {
  test(`visual: coordinator pane (${scheme})`, async ({ page }) => {
    await freezeMiddayCT(page);
    await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemo }));
    await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemoDecisions }));
    await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: agentRunsDemo }));
    await page.route(/\/api\/work\/items\/[^/]+\/coordinator(?:\?.*)?$/, (route) => route.fulfill({ json: coordinatorDemo }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    let sent = 0;
    await page.route(/\/api\/hermes\/sessions(\/.*)?$/, (route) => (route.request().method() === "POST" ? (sent++, route.abort()) : route.fallback()));
    await page.goto("/areas");
    await expect(page.getByRole("heading", { level: 1, name: "Areas" })).toBeVisible();
    const card = page.getByTestId("map-area-card").filter({ hasText: "Jarvis" });
    await expect(card.getByTestId("agents-strip")).toBeVisible();
    await page.getByRole("listitem").filter({ has: card }).getByTestId("coordinator-open").click();
    const pane = page.getByTestId("coordinator-pane");
    await expect(pane.getByTestId("coordinator-agent")).toBeVisible();
    await pane.getByTestId("coordinator-catch-up").click();
    await expect(pane.getByTestId("coordinator-input")).toHaveValue(/Catch me up on the "Jarvis" area/);
    expect(sent).toBe(0);
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({
      content: 'nav[aria-label="Primary"].fixed, .chat-dock, .k-dock, [data-command-dock] { visibility: hidden !important; }',
    });
    await page.waitForTimeout(500);
    await expectNoHorizontalOverflow(page);
    // Element shot + pane-scoped mask: page-level masks also paint boxes for the map BEHIND the pane over it.
    await withoutTray(page, () =>
      expect(pane).toHaveScreenshot(`coordinator-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => pane.locator(m)) }),
    );
    await t.evaluate((el) => (el as Element).remove());
  });
}

/** Global Chief of staff (Phase 1): desktop rail open / collapsed / chat strip, 1000 px, phone tray + sheet tabs, quick actions. */
const gcQuick = (id: string, label: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  id,
  userId: "owner",
  label,
  prompt,
  scope: "global",
  pinned: false,
  sortOrder: 0,
  status: "active",
  source: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const gcQuickActions = [
  gcQuick("gcq1", "Daily brief", "Brief me on today", { pinned: true }),
  gcQuick("gcq2", "Plan my week", "Help me plan this week", { sortOrder: 1 }),
  gcQuick("gcq3", "Weekly review", "Run my weekly review", { status: "proposed", source: "agent:chiefofstaff" }),
];
const GC_HIDE = 'nav[aria-label="Primary"].fixed, .chat-dock, .k-dock, [data-command-dock], .gc-tablet-dock { visibility: hidden !important; }';
async function stubGlobalCoordinator(page: Page) {
  // Relative to the frozen browser clock: the sheet is a top-layer dialog, so masks can't cover its times.
  const at = new Date((await freezeMiddayCT(page)) - 20 * 60_000).toISOString();
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemoDecisions }));
  await page.route(/\/api\/quick-actions(?:\?.*)?$/, (route) => route.fulfill({ json: { actions: gcQuickActions } }));
  await page.route(/\/api\/work\/activity\?actor=agent&q=chiefofstaff/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "gca1",
            at,
            type: "created",
            actor: { kind: "agent", name: "chiefofstaff" },
            verb: "created",
            object: { id: "gci1", title: "Book the furnace tune-up" },
            detail: null,
            via: "chiefofstaff",
            undoOpId: "gcop1",
          },
        ],
        nextCursor: null,
        latestAt: at,
      },
    }),
  );
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
  await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
  await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: 0 } }));
  // Never a real coordinator/Hermes write from a visual test.
  await page.route(/\/api\/hermes\/sessions(\/.*)?$/, (route) => (route.request().method() === "GET" ? route.fallback() : route.abort()));
}
const gcMask = (scope: import("@playwright/test").Locator) => [...MASK, ".gc-action .gc-hint"].map((m) => scope.locator(m));
async function gcTheme(page: Page, scheme: "light" | "dark") {
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

for (const scheme of ["light", "dark"] as const) {
  test(`visual: chief of staff rail open, collapsed and chat strip (${scheme})`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Desktop rail");
    await page.emulateMedia({ colorScheme: scheme });
    await stubGlobalCoordinator(page);
    await page.goto("/more");
    const rail = page.getByRole("complementary", { name: "Chief of staff" });
    await expect(rail).toHaveAttribute("data-open", "true");
    await expect(rail.getByTestId("quick-action-proposal")).toContainText("Weekly review");
    await expect(rail.getByTestId("quick-actions-row").getByRole("button", { name: "Daily brief", exact: true })).toBeVisible();
    await expect(rail.locator(".gc-priority").first()).toContainText("need");
    // A chip only fills the composer.
    await rail.getByTestId("quick-actions-row").getByRole("button", { name: "Plan my week", exact: true }).click();
    await expect(rail.getByTestId("gc-input")).toHaveValue("Help me plan this week");
    await gcTheme(page, scheme);
    const t = await page.addStyleTag({ content: GC_HIDE });
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow(page);
    await withoutTray(page, () => expect(rail).toHaveScreenshot(`gc-rail-open-${scheme}.png`, { animations: "disabled", mask: gcMask(rail) }));
    await rail.getByRole("button", { name: "Collapse Chief of staff" }).click();
    await expect(rail).toHaveAttribute("data-open", "false");
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`gc-rail-collapsed-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => page.locator(m)) });
    await t.evaluate((el) => (el as Element).remove());
    // The chat panel owns the right-hand slot when its container is wide enough.
    await rail.getByRole("button", { name: "Expand Chief of staff" }).click();
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) => route.fulfill({ json: chatVisual }));
    await page.goto("/chat/sess_morning");
    await expect(page.getByText(chatVisual.timeline[2].text!, { exact: true })).toBeVisible();
    await expect(rail).toHaveAttribute("data-open", "false");
    await gcTheme(page, scheme);
    const t2 = await page.addStyleTag({ content: GC_HIDE });
    await page.waitForTimeout(400);
    await withoutTray(page, () => expect(rail).toHaveScreenshot(`gc-rail-strip-${scheme}.png`, { animations: "disabled" }));
    await t2.evaluate((el) => (el as Element).remove());
  });

  test(`visual: chief of staff at 1000px (${scheme})`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "1000px band (rail beside content, header wraps)");
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await stubGlobalCoordinator(page);
    await page.goto("/more");
    const rail = page.getByRole("complementary", { name: "Chief of staff" });
    await expect(rail).toHaveAttribute("data-open", "true");
    await expect(rail.getByTestId("quick-action-proposal")).toBeVisible();
    await gcTheme(page, scheme);
    const t = await page.addStyleTag({ content: GC_HIDE });
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot(`gc-1000-${scheme}.png`, { animations: "disabled", mask: gcMask(page.locator("body")) });
    await t.evaluate((el) => (el as Element).remove());
  });

  test(`visual: chief of staff phone tray and sheet (${scheme})`, async ({ page }, info) => {
    test.skip(info.project.name === "desktop", "Phone tray + sheet");
    await page.emulateMedia({ colorScheme: scheme });
    await stubGlobalCoordinator(page);
    await page.goto("/more");
    const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
    await expect(tray).toBeVisible();
    await expect(tray.locator(".gc-dot:visible")).toBeVisible();
    const pinned = page.getByTestId("quick-actions-tray");
    await expect(pinned.getByRole("button", { name: "Daily brief", exact: true })).toBeVisible();
    await expect(pinned.getByRole("button", { name: "Plan my week", exact: true })).toHaveCount(0);
    await gcTheme(page, scheme);
    const t = await page.addStyleTag({
      content: 'nav[aria-label="Primary"].fixed, .chat-dock, .k-dock, [data-command-dock] { visibility: hidden !important; }',
    });
    await page.waitForTimeout(400);
    // Tray + pinned chips, clipped to the bottom-right corner they float in.
    const box = await page.locator(".gc-host").evaluate(() => {
      const r = [document.querySelector(".gc-tray")!, document.querySelector(".gc-tray-qa")!].map((e) => e.getBoundingClientRect());
      const x = Math.min(...r.map((b) => b.left)) - 4;
      const y = Math.min(...r.map((b) => b.top)) - 4;
      return { x, y, width: Math.max(...r.map((b) => b.right)) + 4 - x, height: Math.max(...r.map((b) => b.bottom)) + 4 - y };
    });
    await expect(page).toHaveScreenshot(`gc-tray-${scheme}.png`, { animations: "disabled", clip: box });
    await t.evaluate((el) => (el as Element).remove());
    // A pinned chip opens the sheet with the composer filled (nothing sent).
    await pinned.getByRole("button", { name: "Daily brief", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Chief of staff" });
    await expect(sheet.getByTestId("gc-input")).toHaveValue("Brief me on today");
    await expect(sheet.getByTestId("quick-action-proposal")).toBeVisible();
    await gcTheme(page, scheme);
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow(page);
    await withoutTray(page, () => expect(sheet).toHaveScreenshot(`gc-sheet-chat-${scheme}.png`, { animations: "disabled", mask: gcMask(sheet) }));
    await sheet.getByRole("tab", { name: /^Changes/ }).click();
    await expect(sheet.getByRole("button", { name: /^Undo Created item/ })).toBeVisible();
    await page.waitForTimeout(200);
    await withoutTray(page, () => expect(sheet).toHaveScreenshot(`gc-sheet-changes-${scheme}.png`, { animations: "disabled", mask: gcMask(sheet) }));
  });
}

test("chief of staff tray never overlaps the tablet dock (640–900px)", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Tablet band");
  await stubGlobalCoordinator(page);
  for (const width of [640, 700, 768, 820, 899]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/more");
    // A hidden second tray can linger from a suspended render (seen in CI): only the visible one counts.
    const tray = page.locator(".gc-tray").filter({ visible: true });
    await expect(tray).toBeVisible();
    await expect(page.getByTestId("quick-actions-tray").filter({ visible: true })).toBeVisible();
    const boxes = await page.evaluate(() =>
      [".gc-tray", ".gc-tray-qa", ".gc-tablet-dock [data-command-dock], .gc-tablet-dock > *"].map((sel) => {
        const rects = [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect());
        const r = rects.find((x) => x.width && x.height);
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      }),
    );
    const [trayBox, chipsBox, dockBox] = boxes;
    expect(trayBox, `tray at ${width}`).not.toBeNull();
    for (const b of [trayBox, chipsBox]) {
      if (!b || !dockBox) continue;
      const overlap = b.left < dockBox.right && dockBox.left < b.right && b.top < dockBox.bottom && dockBox.top < b.bottom;
      expect(overlap, `tray/dock overlap at ${width}px: ${JSON.stringify({ b, dockBox })}`).toBe(false);
    }
    await expectNoHorizontalOverflow(page);
  }
});

/** Batch 5 (H1/C4/A3/C1): House by room, chat list chips + unread, area ⋯ settings dialog, @profile chat badge. */
const HIDE_OVERLAYS = 'nav[aria-label="Primary"], .chat-dock, .k-dock, [data-command-dock] { visibility: hidden !important; }';
const conversationsVisual = (() => {
  const at = (min: number) => new Date(Date.parse(visualNow) - min * 60_000).toISOString();
  const row = (id: string, title: string, min: number, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    preview: null,
    lastActiveAt: at(min),
    backend: "hermes",
    readOnly: false,
    linkedItems: [],
    placement: null,
    shared: false,
    suggestions: [],
    ...extra,
  });
  return {
    conversations: [
      row("sess_rubric", "Lock the V5 rubric", 5, {
        agentProfile: "devchief",
        unread: true,
        unreadCount: 3,
        placement: { nodeId: "wk_cv", parentId: "wk_v5", path: "Momentum Bets › Criteria evaluator", inMisc: false },
      }),
      row("sess_garage", "Shelving options", 40, {
        unread: true,
        unreadCount: null,
        placement: { nodeId: null, parentId: "wk_garage", path: "Home › Garage cleanup", inMisc: false },
      }),
      row("sess_morning", "Morning planning", 90),
      row("sess_dinner", "Dinner ideas", 60 * 30, { placement: { nodeId: "wk_cm", parentId: "wk_misc", path: "Miscellaneous", inMisc: true } }),
    ],
    unfiledCount: 2,
    unreadCount: 2,
    unavailable: [],
    updating: false,
    cachedAt: visualNow,
  };
})();
const settingsArea = {
  ...areaDetailVisual,
  item: { ...areaDetailVisual.item, settings: { ...areaDetailVisual.area.settings, color: "ai" } },
  area: { ...areaDetailVisual.area, settings: { ...areaDetailVisual.area.settings, color: "ai" } },
};
for (const scheme of ["light", "dark"] as const) {
  test(`visual: house by room (${scheme})`, async ({ page }) => {
    await freezeMiddayCT(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => {
      localStorage.removeItem("jarvis:house-view");
      localStorage.setItem("jarvis:house-collapsed", JSON.stringify(["Living room"]));
    });
    // Real mock-HA devices (rooms from /api/template), minus cameras (live stills) and change times.
    await page.route(/\/api\/home-assistant\/devices$/, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { cameras: unknown[]; doors: { lastChanged?: string }[]; lights: { lastChanged?: string }[] };
      const fix = <T extends { lastChanged?: string }>(xs: T[]) => xs.map((x) => ({ ...x, lastChanged: undefined }));
      await route.fulfill({ json: { ...body, cameras: [], doors: fix(body.doors), lights: fix(body.lights) } });
    });
    await page.goto("/home-control");
    await expect(page.locator('section[data-room="Kitchen"]')).toContainText("Kitchen lights");
    await expect(page.locator('section[data-room="Living room"] button[aria-expanded="false"]')).toBeVisible();
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.waitForTimeout(500);
    await expectNoHorizontalOverflow(page);
    // From the By room · All toggle to the last room (exceptions/calendar above and below vary with the mock clock).
    const clip = await page.evaluate(() => {
      const top = document.querySelector('[aria-label="Group devices"]')!.parentElement!.getBoundingClientRect();
      const rooms = [...document.querySelectorAll("section[data-room]")].map((el) => el.getBoundingClientRect());
      const bottom = Math.max(...rooms.map((r) => r.bottom));
      const left = Math.min(top.left, ...rooms.map((r) => r.left));
      const right = Math.max(top.right, ...rooms.map((r) => r.right));
      return { x: Math.floor(left), y: Math.floor(top.top + window.scrollY), width: Math.ceil(right - left), height: Math.ceil(bottom - top.top) };
    });
    await withoutTray(page, () =>
      expect(page).toHaveScreenshot(`house-rooms-${scheme}.png`, { fullPage: true, clip, animations: "disabled", mask: MASK.map((m) => page.locator(m)) }),
    );
    await t.evaluate((el) => (el as Element).remove());
  });

  test(`visual: chat list chips and unread (${scheme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(visualNow));
    await page.emulateMedia({ colorScheme: scheme });
    await page.route(/\/api\/work\/conversations\?view=all(?:&.*)?$/, (route) => route.fulfill({ json: conversationsVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.goto("/chat");
    const rubric = page.locator('[data-conversation="sess_rubric"]');
    await expect(rubric).toHaveAttribute("data-unread", "1");
    await expect(rubric.getByTestId("agent-mark")).toHaveText("@devchief");
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.waitForTimeout(500);
    await expectNoHorizontalOverflow(page);
    // Innermost box holding both the chip row and the list.
    const list = page
      .locator("div")
      .filter({ has: page.getByRole("group", { name: "Show" }) })
      .filter({ has: rubric })
      .last();
    await withoutTray(page, () =>
      expect(list).toHaveScreenshot(`chat-list-unread-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => list.locator(m)) }),
    );
    await t.evaluate((el) => (el as Element).remove());
  });

  test(`visual: area settings dialog (${scheme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(visualNow));
    await page.emulateMedia({ colorScheme: scheme });
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/items\/wk_mb$/, (route) => route.fulfill({ json: settingsArea }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
    await page.goto("/areas?item=wk_mb");
    await expect(page.getByRole("heading", { level: 2, name: "Momentum Bets" })).toBeVisible();
    await expect(page.getByTestId("area-color")).toBeVisible();
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.getByRole("button", { name: "More item actions" }).click();
    await page.getByRole("menuitem", { name: "Area settings…" }).click();
    const dialog = page.getByRole("dialog", { name: "Momentum Bets settings" });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.waitForTimeout(500);
    await withoutTray(page, () =>
      expect(dialog).toHaveScreenshot(`area-settings-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => dialog.locator(m)) }),
    );
    await t.evaluate((el) => (el as Element).remove());
  });

  test(`visual: chat header agent badge (${scheme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(visualNow));
    await page.emulateMedia({ colorScheme: scheme });
    await page.route(/\/api\/notifications\/count$/, (route) => route.fulfill({ json: { unread: alertsVisual.unread } }));
    await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (route) =>
      route.fulfill({ json: { ...chatVisual, session: { ...chatVisual.session, agentProfile: "devchief" } } }),
    );
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
    await page.goto("/chat/sess_morning");
    const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 1, name: "Morning planning" }) });
    await expect(header.getByTestId("agent-badge")).toHaveText("@devchief");
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.waitForTimeout(500);
    await withoutTray(page, () =>
      expect(header).toHaveScreenshot(`chat-agent-badge-${scheme}.png`, { animations: "disabled", mask: MASK.map((m) => header.locator(m)) }),
    );
    await t.evaluate((el) => (el as Element).remove());
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`visual: skylight write (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    const fixture = skylightWriteVisual(new Date(await page.evaluate(() => new Date().toISOString())));
    await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (route) => route.fulfill({ json: fixture }));
    await page.route(/\/api\/settings$/, (route) => route.fulfill({ json: { timezone: "America/Chicago" } }));
    await page.goto("/skylight");
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await expect(page.getByRole("radio", { name: "Mine", exact: true })).toBeChecked();
    await expect(page.getByRole("heading", { name: "Visualsky Groceries" })).toBeVisible();
    await expect(page.getByText("Visualsky family walk", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New event", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const overlays = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page).toHaveScreenshot(`skylight-write-${scheme}.png`, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
    await page.getByRole("checkbox", { name: /Done: .*Visualsky water the ferns/ }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm Skylight change" });
    await expect(confirm).toContainText("Visualsky water the ferns");
    await withoutTray(page, () => expect(confirm).toHaveScreenshot(`skylight-write-confirm-${scheme}.png`));
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await overlays.evaluate((el) => (el as Element).remove());
  });
}

// Skylight completed chores (stubbed source, light + dark).
for (const scheme of ["light", "dark"] as const) {
  test(`visual: skylight done today (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (route) => route.fulfill({ json: skylightVisual() }));
    await page.goto("/skylight");
    await page.locator("h1").first().waitFor();
    await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
    await expect(page.getByTestId("skylight-done")).toContainText("Visualsky wipe the stovetop");
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const t = await page.addStyleTag({ content: 'nav[aria-label="Primary"].fixed, .chat-dock { visibility: hidden !important; }' });
    await expect(page).toHaveScreenshot(`skylight-done-${scheme}.png`, { fullPage: false, mask: MASK.map((m) => page.locator(m)) });
    await t.evaluate((el) => (el as Element).remove());
  });
}

// Skylight-style grouping: Morning/Afternoon/Evening/Anytime, Next 7 days, Overdue at the bottom, suggested icon actions.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: skylight grouping (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    const fixture = skylightGroupingVisual(new Date(await page.evaluate(() => new Date().toISOString())));
    await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (route) => route.fulfill({ json: fixture }));
    await page.route(/\/api\/sources\/todos(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          status: { ...fixture.status, source: "todos", label: "Todos" },
          data: { actions: [], events: [], extra: { provider: "home_assistant" } },
        },
      }),
    );
    await page.route(/\/api\/settings$/, (route) => route.fulfill({ json: { timezone: "America/Chicago" } }));
    for (const path of ["/skylight", "/todos"] as const) {
      await page.goto(path);
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      const overdue = page.getByRole("region", { name: /^Overdue/ });
      await expect(overdue).toContainText("Visualsky descale the kettle");
      await expect(overdue.getByRole("button", { name: /^Do now: .*Visualsky feed the fish/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Claim: .*Visualsky fold the towels/ })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const overlays = await page.addStyleTag({ content: `${HIDE_OVERLAYS} .gc-tray, .gc-tray-qa { visibility: hidden !important; }` });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      // The main column only: the sidebar/rail list other specs' chats, which this test doesn't own.
      const main = page.locator("main#main");
      await expect(main).toHaveScreenshot(`skylight-grouping${path === "/todos" ? "-todos" : ""}-${scheme}.png`, {
        mask: MASK.map((m) => main.locator(m)),
      });
      await overlays.evaluate((el) => (el as Element).remove());
    }
  });
}

/** Map is Areas PR 2: the area page (project cards → tree with relation chips, coordinator column ≥1280 / sheet below). */
async function openDemoArea(page: Page) {
  await freezeMiddayCT(page);
  await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemo }));
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemoDecisions }));
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: agentRunsDemo }));
  await page.route(/\/api\/work\/items\/ma_j$/, (route) => route.fulfill({ json: mapDemoAreaDetail }));
  await page.route(/\/api\/work\/items\/[^/]+\/coordinator(?:\?.*)?$/, (route) => route.fulfill({ json: coordinatorDemo }));
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: { ...areasVisual, items: [...areasVisual.items, ...mapDemo.items] } }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
  await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
  await page.goto("/areas?item=ma_j");
  await expect(page.getByRole("heading", { level: 2, name: "Jarvis" })).toBeVisible();
  await expect(page.getByTestId("area-project-card")).toHaveCount(2);
}

for (const scheme of ["light", "dark"] as const) {
  test(`visual: area map page (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openDemoArea(page);
    const wide = (page.viewportSize()?.width ?? 0) >= 1280;
    if (wide) await expect(page.getByTestId("area-coordinator")).toBeVisible();
    else await expect(page.getByTestId("area-coordinator-sheet-open")).toBeVisible();
    const shoot = async (name: string) => {
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
      await page.waitForTimeout(500);
      await expectNoHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(name, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
      await t.evaluate((el) => (el as Element).remove());
    };
    await shoot(`area-map-${scheme}.png`);
    // Tree view: every item with its "depends on" / "follow-up of" chips.
    await page.getByRole("group", { name: "Area view" }).getByRole("button", { name: "Tree" }).click();
    await expect(page.getByTestId("map-relations").first()).toBeVisible();
    await shoot(`area-map-tree-${scheme}.png`);
    await page.getByRole("group", { name: "Area view" }).getByRole("button", { name: "Cards" }).click();
    if (info.project.name === "desktop") {
      // Foldable (unfolded, ~1000 px): no column, the coordinator is a sheet.
      await page.setViewportSize({ width: 1000, height: 800 });
      await expect(page.getByTestId("area-coordinator-sheet-open")).toBeVisible();
      await expect(page.getByTestId("area-coordinator")).toBeHidden();
      await shoot(`area-map-fold-${scheme}.png`);
    }
  });
}

/** Areas v2: the Board and Graph tabs of the demo area (pane-only shots; selection kept by the tabs). */
for (const scheme of ["light", "dark"] as const) {
  test(`visual: areas v2 board + graph (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openDemoArea(page);
    const views = page.getByRole("tablist", { name: "Views" });
    const panel = page.locator("#areas-tabpanel");
    const shoot = async (name: string) => {
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
      await page.waitForTimeout(500);
      await expectNoHorizontalOverflow(page);
      await withoutTray(page, () => expect(panel).toHaveScreenshot(name, { animations: "disabled", mask: MASK.map((m) => panel.locator(m)) }));
      await t.evaluate((el) => (el as Element).remove());
    };
    await views.getByRole("tab", { name: "Board", exact: true }).click();
    await expect(page.getByTestId("map-tree")).toBeVisible();
    await shoot(`areas-board-${scheme}.png`);
    await views.getByRole("tab", { name: "Graph", exact: true }).click();
    await expect(page.getByTestId("radial-graph").locator('[data-centre="true"]')).toBeVisible();
    await shoot(`areas-graph-${scheme}.png`);
    if (info.project.name === "desktop") {
      // Foldable (unfolded, ~1000 px): the selected-node card stacks under the graph.
      await page.setViewportSize({ width: 1000, height: 800 });
      await shoot(`areas-graph-fold-${scheme}.png`);
    }
  });
}

// Agent access (docs/agent-tools.md): Settings → Agents card with fixed tokens (one revoked), and Activity
// rows an agent token made ("by @profile" chips). Every list stubbed so other specs' data never leaks in.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: agent access + agent activity (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    await page.route(/\/api\/settings\/agents\/tokens$/, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              tokens: [
                {
                  id: "agt_v1",
                  name: "Chief of staff",
                  profile: "chiefofstaff",
                  scopes: ["work.read", "work.write", "decisions.write", "runs.write"],
                  hint: "x7Qe",
                  createdAt: ago(60 * 26),
                  lastUsedAt: ago(4),
                  revokedAt: null,
                },
                {
                  id: "agt_v2",
                  name: "Old dev token",
                  profile: "devchief",
                  scopes: ["work.read"],
                  hint: "M2pa",
                  createdAt: ago(60 * 24 * 9),
                  lastUsedAt: null,
                  revokedAt: ago(60 * 24 * 2),
                },
              ],
            },
          })
        : route.continue(),
    );
    await page.goto("/settings/agents");
    const card = page.getByTestId("agent-access");
    await expect(card.getByTestId("agent-token-row")).toHaveCount(2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t = await page.addStyleTag({ content: HIDE_OVERLAYS });
    // At 320 the card is far taller than the viewport: an element shot that has to scroll draws the
    // mask boxes ~15 px off their rows (deterministic after #212 + #213 merged). Grow the viewport so
    // the whole card fits (320 only; 412/desktop baselines unchanged), then restore it for the Activity half.
    const vp = page.viewportSize();
    const box = await card.boundingBox();
    if (vp && vp.width <= 360 && box && box.height + 120 > vp.height) await page.setViewportSize({ width: vp.width, height: Math.ceil(box.height) + 240 });
    await page.waitForTimeout(300);
    await withoutTray(page, () => expect(card).toHaveScreenshot(`agent-access-${scheme}.png`, { mask: MASK.map((m) => card.locator(m)) }));
    if (vp) await page.setViewportSize(vp);
    await t.evaluate((el) => (el as Element).remove());

    // Fixed single-digit-hour wall time on today's CT date (14:05Z = 8:05 CST / 9:05 CDT): the
    // row time is masked but its width still counts, and "11:06 AM" rewraps the last row at 320 px.
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const rowAt = `${ymd}T14:05:00.000Z`;
    const row = (id: string, verb: string, title: string, via: string | null, undo = false) => ({
      id,
      at: rowAt,
      type: verb === "created" ? "created" : "edit",
      actor: via ? { kind: "agent", name: via } : { kind: "you", name: "You" },
      verb,
      object: { id: `wk_${id}`, title },
      detail: null,
      undoOpId: undo ? `op_${id}` : null,
      ...(via ? { via } : {}),
    });
    await page.route(/\/api\/work\/items(\?.*)?$/, (route) => route.fulfill({ json: { items: [], linkedConversations: [] } }));
    await page.route(/\/api\/work\/activity(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          items: [
            row("a1", "created", "Price the dust ducting", "chiefofstaff", true),
            row("a2", "edited · next action", "Spokeshave tune-up", "chiefofstaff", true),
            row("a3", "edited · title", "Workshop lighting", null),
          ],
          nextCursor: null,
          latestAt: rowAt,
        },
      }),
    );
    await page.goto("/areas/activity");
    const feed = page.getByRole("region", { name: "All activity" });
    await expect(feed.getByTestId("agent-chip")).toHaveCount(2);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const t2 = await page.addStyleTag({ content: HIDE_OVERLAYS });
    await page.waitForTimeout(300);
    await withoutTray(page, () =>
      expect(feed.locator(".jv-activity-days")).toHaveScreenshot(`agent-activity-${scheme}.png`, { mask: MASK.map((m) => feed.locator(m)) }),
    );
    await t2.evaluate((el) => (el as Element).remove());
  });
}

// Phase 3 gaps: full Agents page was missing (agent-access above crops only one card).
// Settings/todos/people/house/workouts and the palette already run on all projects above; do not duplicate those shots.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: coordinators settings page (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await stubPhase3Settings(page);
    await page.goto("/settings/agents");
    await expect(page.getByRole("heading", { name: /^Coordinators/ })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Shared daily AI job budget used", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot(`settings-agents-coordinators-${scheme}.png`, { fullPage: true, mask: MASK.map((m) => page.locator(m)) });
  });

  test(`visual: appearance settings card (${scheme})`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Settings desktop appearance detail; page shots already cover phone");
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    await stubPhase3Settings(page);
    await page.goto("/settings");
    const appearance = page.getByRole("region", { name: "Appearance", exact: true });
    await expect(appearance.getByRole("radiogroup", { name: "Density", exact: true })).toBeVisible();
    const overlays = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock, .gc-tray { visibility: hidden !important; }' });
    try {
      await expect(appearance).toHaveScreenshot(`settings-appearance-${scheme}.png`);
    } finally {
      await overlays.evaluate((el) => (el as Element).remove());
    }
  });
}

// Worker B: appended v2 catalog and deterministic C+ dynamic sheet contracts.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: Prismv2 weekly review sheet (${scheme})`, async ({ page }, testInfo) => {
    await freezeMiddayCT(page);
    await page.emulateMedia({ colorScheme: scheme });
    await stubPrismV2(page);
    await page.goto("/more");
    if (testInfo.project.name === "desktop") await page.locator(".gc-priority").getByRole("button", { name: "Fill in", exact: true }).click();
    else {
      // Tap only once the tray shows the card line: an earlier tap opens the sheet without the card.
      const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
      await expect(tray).toContainText("Weekly review");
      await tray.click();
    }
    const panel = page.locator(testInfo.project.name === "desktop" ? ".gc-rail" : ".gc-sheet");
    await expect(panel.getByRole("heading", { name: "Prismv2 weekly review" })).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const style = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock, .gc-tray { visibility: hidden !important; }' });
    await expect(panel).toHaveScreenshot(`prismv2-weekly-review-${scheme}.png`);
    await style.evaluate((el) => (el as Element).remove());
  });
  test(`visual: Prismv2 matrix Gantt BarChart chat (${scheme})`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile-320", "Catalog board at desktop + 412; sheet also covers 320");
    await freezeMiddayCT(page);
    await page.emulateMedia({ colorScheme: scheme });
    await stubPrismV2(page, []);
    await openPrismChat(page);
    const surface = page.getByTestId("smart-surface").first();
    await expect(surface.getByRole("heading", { name: "Prismv2 completions" })).toBeVisible();
    const style = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock, .gc-tray { visibility: hidden !important; }' });
    await expect(surface).toHaveScreenshot(`prismv2-catalog-${scheme}.png`);
    await style.evaluate((el) => (el as Element).remove());
  });
}

// FI1: isolated read-only finance data; no mutations, live accounts or AI calls.
for (const scheme of ["light", "dark"] as const) {
  test(`visual: finance snapshot (${scheme})`, async ({ page }, info) => {
    test.skip(!["desktop", "mobile"].includes(info.project.name), "Snapshot coverage: desktop and 412px phone");
    await page.emulateMedia({ colorScheme: scheme });
    await freezeMiddayCT(page);
    const fixture = financeSnapshotFixture();
    await page.clock.setFixedTime(new Date(fixture.now));
    await page.route(/\/api\/finance\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: fixture.overview }));
    const aiRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/ai(?:\/|\?)/.test(request.url())) aiRequests.push(request.url());
    });
    await page.goto("/finance");
    const snapshot = page.getByRole("region", { name: "Snapshot", exact: true });
    await expect(snapshot.getByText("57,000.00", { exact: true })).toBeVisible();
    await expect(snapshot.getByText("+3,466.00", { exact: true })).toBeVisible();
    await expect(snapshot.locator("svg polyline")).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    const overlays = await page.addStyleTag({ content: 'nav[aria-label="Primary"], .chat-dock, .gc-tray { visibility: hidden !important; }' });
    try {
      await expect(snapshot).toHaveScreenshot(`finance-snapshot-${scheme}.png`);
    } finally {
      await overlays.evaluate((el) => (el as Element).remove());
    }
    await page.getByLabel("Hide amounts on this device").check();
    await expect(snapshot.getByText("57,000.00", { exact: true })).toHaveCount(0);
    await expect(snapshot.locator("svg")).toHaveCount(0);
    expect(aiRequests).toEqual([]);
  });
}

// Phase 4 lane 2: scoped ledger shots in every existing viewport project.
for (const scheme of ["light", "dark"] as const) {
  for (const surface of ["schedules", "while-away"] as const) {
    test(`visual: ${surface} quiet ledger (${scheme})`, async ({ page }) => {
      const frozen = await freezeMiddayCT(page);
      await page.emulateMedia({ colorScheme: scheme });
      const date = localDate(new Date(frozen), "America/Chicago");
      if (surface === "schedules") {
        await stubPhase3Settings(page);
        await page.route("**/api/agents/schedules", (route) => route.fulfill({ json: schedulesFixture(date) }));
      } else {
        await page.route("**/api/agents/away", (route) => route.fulfill({ json: awayFixture(date) }));
        await page.route(/\/api\/home(?:\?.*)?$/, (route) => route.fulfill({ json: homeVisual }));
        await page.route("**/api/home/pulse", (route) => route.fulfill({ json: homePulseVisual }));
      }
      await page.goto(surface === "schedules" ? "/settings/agents#schedules" : "/home");
      const pane = surface === "schedules" ? page.locator("#schedules") : page.locator("main").getByTestId("while-away").first();
      await expect(pane.getByText("Lantern morning check", { exact: true })).toBeVisible();
      const overlays = await page.addStyleTag({
        content: 'nav[aria-label="Primary"], .chat-dock, .gc-tray, .gc-tray-qa, [data-testid="quick-actions-host"] { visibility: hidden !important; }',
      });
      const viewport = page.viewportSize();
      try {
        // Element screenshots cannot scroll a tall 320px card under fixed overlays safely.
        if (viewport?.width === 320) {
          const height = await pane.evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
          if (height + 80 > viewport.height) await page.setViewportSize({ width: viewport.width, height: height + 80 });
        }
        await pane.scrollIntoViewIfNeeded();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expectNoHorizontalOverflow(page);
        await expect(pane).toHaveScreenshot(`${surface}-${scheme}.png`, { mask: [pane.locator("[data-dynamic]")] });
      } finally {
        await overlays.evaluate((el) => (el as Element).remove());
        if (viewport) await page.setViewportSize(viewport);
      }
    });
  }
}
