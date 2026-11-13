import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { stubPhase3Settings } from "./fixtures/phase3-gaps";
import { ensureWorkflowActive, expectNoHorizontalOverflow, mock, openChatPanel, startConversation } from "./helpers";
import { forceSourceState, SOURCE_STATES } from "./fixtures/states";
import { PHOTO_PNG } from "./fixtures/chat-files";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";
import { mapDemo, mapDemoAreaDetail, mapDemoDecisions } from "./fixtures/map-demo";
import { agentRunsDemo, coordinatorDemo } from "./fixtures/agents-demo";
import { noticesVisual } from "./fixtures/coordinator-chat";
import { areasVisual, inboxVisual, itemDetailVisual } from "./fixtures/chat-alerts";
import { skylightGroupingVisual, skylightWriteVisual } from "./fixtures/skylight";
import { stubPrismV2 } from "./fixtures/smart-v2";
import { awayFixture, schedulesFixture } from "./fixtures/away";
import { feedbackVisual } from "./fixtures/feedback";

const PAGES = [
  "/home",
  "/home/all?bucket=backlog",
  "/settings/home",
  "/chat",
  "/chat/sess_morning",
  "/alerts",
  "/more",
  "/workflows",
  "/todos",
  "/home-control",
  "/initiatives",
  "/settings",
  "/settings/connections",
  "/settings/connections#github",
  "/settings/notifications",
  "/settings/phones",
  "/brain",
  "/daily-compass",
  "/skylight",
  "/settings/people",
  "/workouts",
  "/finance",
  "/finance/accounts",
  "/finance/funds",
  "/finance/plan",
  "/finance/checkin?all=1",
  "/areas",
  "/inbox",
  "/areas?view=tree",
  "/areas/timeline",
  "/areas/dashboard",
  "/areas/map",
  "/areas?tab=board",
  "/areas?tab=portfolio",
  "/areas/activity",
  "/decisions",
  "/resume",
  "/capture",
  "/settings/ai",
  "/settings/agents",
  "/settings/places",
  "/dev/ui",
];

for (const path of PAGES) {
  test(`a11y + reflow: ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.waitForTimeout(800);
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      serious.map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(" | ")}`,
      ),
    ).toEqual([]);
  });
}

// a11y tests stub or seed what they check, so CI spreads them test-by-test across workers and shards (each
// worker has its own server, e2e/servers.ts); a test that needs an earlier one's state belongs in a serial describe.
test.describe.configure({ mode: "parallel" });

test("200% text zoom does not cause horizontal scrolling", async ({ page }) => {
  // One page per entry; the list outgrew the 60 s default on mobile-320 (Phase 4 added /areas?tab=portfolio).
  test.setTimeout(120_000);
  await page.route("**/api/agents/schedules", (route) => route.fulfill({ json: schedulesFixture() }));
  await page.route("**/api/agents/away", (route) => route.fulfill({ json: awayFixture() }));
  for (const path of [
    "/home",
    "/more",
    "/chat/sess_morning",
    "/alerts",
    "/settings",
    "/settings/agents",
    "/todos",
    "/skylight",
    "/home-control",
    "/settings/people",
    "/workouts",
    "/finance",
    "/finance/plan",
    "/workflows",
    "/areas/activity",
    "/areas",
    "/areas?tab=graph",
    "/areas?tab=board",
    "/areas?tab=portfolio",
    "/decisions",
    "/resume",
  ]) {
    await page.goto(path);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    // Soft: report every overflowing page in one run instead of stopping at the first.
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("Skylight write dialogs: axe clean and reflow at 200% text zoom", async ({ page }) => {
  await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (route) => route.fulfill({ json: skylightWriteVisual() }));
  await page.route(/\/api\/settings$/, (route) => route.fulfill({ json: { timezone: "America/Chicago" } }));
  await page.goto("/skylight");
  const checkDialog = async () => {
    await expect(page.getByRole("dialog")).toBeVisible();
    const results = await new AxeBuilder({ page: page as never }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(
      results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
    const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expectNoHorizontalOverflow(page);
    await zoom.evaluate((el) => (el as Element).remove());
  };
  const opener = page.getByRole("checkbox", { name: /Done: .*Visualsky water the ferns/ });
  await opener.click();
  await checkDialog();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: "New event", exact: true }).click();
  await checkDialog();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
});

test("Skylight grouped chores with suggested actions: axe clean, ≥40px targets and reflow at 200% text zoom", async ({ page }) => {
  await page.route(/\/api\/sources\/skylight(?:\?.*)?$/, (route) => route.fulfill({ json: skylightGroupingVisual() }));
  await page.route(/\/api\/settings$/, (route) => route.fulfill({ json: { timezone: "America/Chicago" } }));
  for (const path of ["/skylight", "/todos"]) {
    await page.goto(path);
    const overdue = page.getByRole("region", { name: /^Overdue/ });
    await expect(overdue).toContainText("Visualsky descale the kettle", { timeout: 15_000 });
    const results = await new AxeBuilder({ page: page as never }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(
      results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any.map((a) => a.message).join("; ")}`).join(", ")}`),
    ).toEqual([]);
    const min = (page.viewportSize()?.width ?? 0) < 640 ? 44 : 40;
    for (const b of await page
      .getByRole("group", { name: /^Suggested actions/ })
      .getByRole("button")
      .all()) {
      const box = await b.boundingBox();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(min - 0.5);
    }
    const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
    await zoom.evaluate((el) => (el as Element).remove());
  }
});

test("200% text zoom at 1024 (sidebar + header dock) does not cause horizontal scrolling", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, "desktop sidebar layout only");
  await page.setViewportSize({ width: 1024, height: 768 });
  for (const path of ["/home", "/areas", "/alerts", "/settings"]) {
    await page.goto(path);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("forced source states: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  for (const name of Object.keys(SOURCE_STATES) as (keyof typeof SOURCE_STATES)[]) {
    await page.unrouteAll();
    const path = await forceSourceState(page, name);
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.waitForTimeout(500);
    const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect.soft(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${name} ${v.id}`)).toEqual([]);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("approval card: axe clean and no overflow at 200% text zoom (choices + undo states)", async ({ page, request }) => {
  await mock(request, "/reset");
  await startConversation(page, "please delete the build folder");
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const axe = async () => {
    const results = await new AxeBuilder({ page: page as never })
      .include('[data-testid="approval-card"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  };
  await axe();
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page);
  await card.getByRole("button", { name: "Approve once" }).click();
  await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await axe();
  // Undo leaves the request unanswered (still awaiting a choice).
  await card.getByRole("button", { name: "Undo" }).click();
  await expect(card.getByRole("button", { name: "Approve once" })).toBeVisible();
  // Resolve the request so its "needs approval" item doesn't leak into later specs (home-all visual).
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(card).toBeHidden({ timeout: 15_000 });
});

test("coordinator notices + clarify card: axe clean and no overflow at 200% text zoom", async ({ page, request }) => {
  await mock(request, "/reset");
  await page.route(/\/api\/hermes\/sessions\/sess_notices$/, (route) => route.fulfill({ json: noticesVisual }));
  await page.route(/\/api\/hermes\/sessions\/sess_notices\/links-panel$/, (route) => route.fulfill({ json: { links: [] } }));
  await page.route(/\/api\/hermes\/sessions\/sess_notices\/files$/, (route) => route.fulfill({ json: { files: [] } }));
  await page.goto("/chat/sess_notices");
  const notice = page.getByTestId("chat-notice").first();
  await expect(notice).toBeVisible();
  await notice.locator("summary").first().click();
  await notice.getByTestId("notice-task").first().locator("summary").click();
  await page.getByText("Earlier conversation summarized").click();
  const axe = async (sel: string) => {
    const results = await new AxeBuilder({ page: page as never }).include(sel).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(
      results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(",")}`),
    ).toEqual([]);
  };
  await axe('[aria-label="Conversation timeline"]');
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page);

  // Clarify card (mock Hermes asks when the message says "clarify"), then answer it so nothing leaks.
  await page.goto("/chat");
  await startConversation(page, "Please clarify the accent first");
  const card = page.getByTestId("clarify-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await axe('[data-testid="clarify-card"]');
  const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page);
  // #185: at 320 px + 200% text the composer stays one compact row while the question waits, so the
  // card's choices are tappable without leaving the zoom.
  const teal = card.getByRole("button", { name: "Teal" });
  await teal.scrollIntoViewIfNeeded();
  await teal.click();
  await zoom.evaluate((el) => (el as Element).remove());
  await expect(card).toBeHidden({ timeout: 15_000 });
});

test("touch targets in primary navigation are at least 44px", async ({ page }) => {
  await page.goto("/home");
  // Primary nav (phone bar / tablet top row) plus the header bar's own actions (New, Settings…).
  // The Ask dock is a search field in its own landmark (compact by design), not a nav target.
  const sizes = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'nav[aria-label="Primary"] a, nav[aria-label="Primary"] button, .jv-shell > header a, .jv-shell > header button',
      ),
    ]
      .filter((el) => !el.closest('[role="search"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, w: r.width, h: r.height };
      }),
  );
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.filter((s) => s.w < 44 || s.h < 44)).toEqual([]);
});

test("chat composer with attachments: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  await startConversation(page, "kestrel attachments zoom");
  await expect(page.getByText(/Got it: "kestrel attachments/)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("chat-file-input").setInputFiles([
    { name: "kestrel-a-very-long-picture-name-for-the-overflow-check.png", mimeType: "image/png", buffer: PHOTO_PNG },
    { name: "kestrel-notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  await expect(page.getByTestId("attachment-chip").nth(1)).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  const results = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect
    .soft(
      results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    )
    .toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  // Every composer control stays a 44 px target and inside the viewport.
  const vw = page.viewportSize()!.width;
  for (const name of ["Add to message", "Attach context", "Attach files or pictures", "Take a photo"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (!(await button.count())) continue; // camera is hidden on pointer:fine
    const box = await button.boundingBox();
    if (!box) continue;
    expect.soft(box.x + box.width, name).toBeLessThanOrEqual(vw);
    expect.soft(box.height, name).toBeGreaterThanOrEqual(44);
  }
});

test("raycast palette: axe clean and no overflow at 200% text zoom (root, typed, actions, confirm)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const made = await page.request.post("/api/work/items", { data: { kind: "area", title: `Zoom aviary ${nonce}` }, headers: { "x-jarvis-csrf": "1" } });
  expect(made.ok()).toBeTruthy();
  await page.getByRole("heading", { name: "Now" }).waitFor();
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(box).toBeFocused({ timeout: 1000 });
  }).toPass();
  await expect(page.getByRole("option", { name: /Browse areas/ })).toBeVisible();
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
        label,
      )
      .toEqual([]);
  };
  await axe("root");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await box.fill(`new item in zoom aviary ${nonce}`);
  await expect(page.locator('[data-command="action.new-item"]')).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-chips")).toContainText(`Zoom aviary ${nonce}`);
  await box.fill("Zoom check sparrow");
  await expectNoHorizontalOverflow(page, { soft: true });
  await axe("typed");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette-confirm")).toBeVisible();
  await expectNoHorizontalOverflow(page, { soft: true });
  await axe("confirm");
  await page.getByTestId("palette-confirm").getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
});

test("200% text zoom: item, area and activity pages (Areas nav, New menu, Undo rows) do not scroll the page sideways (#112)", async ({ page }) => {
  test.setTimeout(120_000);
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const post = async (data: unknown) => {
    const r = await page.request.post("/api/work/items", { data, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const areaId = await post({ kind: "area", title: `Zoom lantern ${nonce}` });
  const id = await post({ kind: "thread", parentId: areaId, title: `Zoom wick ${nonce}` });
  // A fresh undoable edit: its activity row carries Undo + time, the widest row at 200% text.
  const renamed = await page.request.patch(`/api/work/items/${id}`, { data: { title: `Zoom wick renamed ${nonce}` }, headers: { "x-jarvis-csrf": "1" } });
  expect(renamed.ok()).toBeTruthy();
  for (const path of [`/areas?item=${id}`, `/areas?item=${areaId}`, "/areas/activity"]) {
    await page.goto(path);
    await expect(page.locator(path.includes("item=") ? "#work-item-title" : "h1").first()).toBeVisible();
    if (!path.includes("item=")) await expect(page.getByRole("button", { name: /^Undo/ }).first()).toBeVisible();
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    // The Areas sections row scrolls inside its own box; the page itself must not.
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("tags + assignee (#111): axe clean and no overflow at 200% text zoom (item editor, area list chips + filter, activity filter)", async ({ page }) => {
  test.setTimeout(120_000);
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const post = async (data: unknown) => {
    const r = await page.request.post("/api/work/items", { data, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const areaId = await post({ kind: "area", title: `Zoom thimble ${nonce}` });
  const id = await post({ kind: "thread", parentId: areaId, title: `Zoom bobbin ${nonce}` });
  const p = await page.request.patch(`/api/work/items/${id}`, {
    data: { tags: [`zoom-spool-with-a-long-tag-${nonce}`, "zoom-hem"], assignee: "agent:momentumchief" },
    headers: { "x-jarvis-csrf": "1" },
  });
  expect(p.ok(), await p.text()).toBeTruthy();
  for (const path of [`/areas?item=${id}`, `/areas?item=${areaId}`, "/areas/activity"]) {
    await page.goto(path);
    await expect(page.locator('[data-tag="zoom-hem"], [data-testid$="-filter"]').filter({ visible: true }).first()).toBeVisible();
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} ${n.failureSummary ?? ""}`).join(" ")}`),
        path,
      )
      .toEqual([]);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
  }
});

test("inline edits: axe clean and no overflow at 200% text zoom (read, title editor, summary editor)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const post = async (data: unknown) => {
    const r = await page.request.post("/api/work/items", { data, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const areaId = await post({ kind: "area", title: `Zoom inkpot ${nonce}` });
  const id = await post({ kind: "thread", parentId: areaId, title: `Zoom quill ${nonce}` });
  await page.goto(`/areas?item=${id}`);
  await expect(page.locator("#work-item-title")).toHaveText(`Zoom quill ${nonce}`);
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id),
        label,
      )
      .toEqual([]);
  };
  await axe("read");
  await page.locator("#work-item-title").getByRole("button").click();
  await expect(page.getByRole("textbox", { name: "Edit title" })).toBeFocused();
  await axe("title editor");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  // The item header must reflow (the Areas nav row above it scrolls sideways by design at 200%).
  const header = page.locator('article[aria-labelledby="work-item-title"] > section').first();
  const fits = () => header.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect.soft(await fits(), "title editor at 200%").toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit summary" }).click();
  await expect(page.getByRole("textbox", { name: "Edit summary" })).toBeFocused();
  await axe("summary editor");
  expect.soft(await fits(), "summary editor at 200%").toBe(true);
  await page.keyboard.press("Escape");
});

test("workflow builder, edit and save-chat review: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  test.setTimeout(120_000);
  const data = { ...teaching, slug: "zoombuild", name: "Zoom builder", triggers: [{ kind: "palette", command: "/zoombuild" }] };
  await ensureWorkflowActive(page, data);
  const check = async (path: string, ready: string) => {
    await page.goto(path);
    await page.getByRole("heading", { name: ready }).first().waitFor();
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
        path,
      )
      .toEqual([]);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
  };
  await check("/workflows/new", "New workflow");
  await check("/workflows/zoombuild/edit", "Edit Zoom builder");
  await check("/workflows/zoombuild", "Session history"); // W4 workflow page: history, stats, reminder
  await check("/workflows/new?fromChat=sess_morning", "Review the proposed workflow");
});

test("workflow start form + run panel: axe clean and no overflow at 200% text zoom", async ({ page }) => {
  const data = { ...teaching, slug: "zoomnotes", name: "Zoom notebook", triggers: [{ kind: "palette", command: "/zoomnotes" }] };
  await ensureWorkflowActive(page, data);
  await page.goto("/workflows");
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
        label,
      )
      .toEqual([]);
  };
  const form = page.getByRole("dialog", { name: "New session" });
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("jarvis:workflow-start", { detail: { command: "/zoomnotes Zed Quill John 15" } })));
    await expect(form).toBeVisible({ timeout: 2000 });
  }).toPass();
  await axe("start form");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await page.addStyleTag({ content: "html { font-size: 100% !important; }" });
  await form.getByTestId("workflow-start-submit").click();
  await expect(page).toHaveURL(/\/chat\//);
  const panel = page.getByTestId("workflow-run");
  await openChatPanel(page, "Outline");
  await expect(panel).toContainText("Zed Quill");
  await axe("run panel");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await page.addStyleTag({ content: "html { font-size: 100% !important; }" });
  // W4: Edit session (#132) and the end form, then the outputs (summary, actions, export).
  await panel.getByTestId("workflow-edit-session").click();
  await expect(page.getByRole("dialog", { name: "Edit session" })).toBeVisible();
  await axe("edit session");
  await page.getByRole("dialog", { name: "Edit session" }).getByRole("button", { name: "Cancel" }).click();
  await panel.getByRole("button", { name: "End session" }).click();
  const endForm = page.getByRole("dialog", { name: "Before you go" });
  await expect(endForm).toBeVisible();
  await axe("end form");
  await endForm.getByTestId("workflow-end-submit").click();
  await expect(panel).toContainText("Ended");
  await openChatPanel(page, "Outputs");
  await expect(panel.getByTestId("workflow-outputs")).toBeVisible();
  await axe("run outputs");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
});

test("drive + offline bible (#141/#142): axe clean and no overflow at 200% text zoom (settings panels, verse text, drive confirm)", async ({ page }) => {
  const H = { "x-jarvis-csrf": "1" };
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(", ")}`),
        label,
      )
      .toEqual([]);
  };
  const zoom = async () => {
    const t = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
    await t.evaluate((el) => (el as Element).remove());
  };
  try {
    expect((await page.request.post("/api/bible", { data: { confirm: true }, headers: H })).ok()).toBe(true);
    // mock consent: start → mock authorize → callback → Settings
    await page.goto("/api/integrations/drive/oauth/start");
    await expect(page).toHaveURL(/\/settings\/connections\?drive=connected/);
    await expect(page.getByTestId("drive-connected")).toBeVisible();
    await axe("drive panel");
    await zoom();
    await page.getByRole("button", { name: /Offline Bible/ }).click();
    await expect(page.getByTestId("bible-installed")).toBeVisible();
    await axe("bible panel");
    await zoom();

    const data = { ...teaching, slug: "zoomdrive", name: "Zoom drive notebook", triggers: [{ kind: "palette", command: "/zoomdrive" }] };
    await ensureWorkflowActive(page, data);
    await page.goto("/workflows");
    const form = page.getByRole("dialog", { name: "New session" });
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("jarvis:workflow-start", { detail: { command: "/zoomdrive Zed Quill John 15" } })));
      await expect(form).toBeVisible({ timeout: 2000 });
    }).toPass();
    await expect(form.getByTestId("scripture-passage")).toContainText("true vine");
    await axe("start form with verse text");
    await zoom();
    await form.getByTestId("workflow-start-submit").click();
    await expect(page).toHaveURL(/\/chat\//);
    const panel = page.getByTestId("workflow-run");
    await openChatPanel(page, "Outline");
    await panel.getByRole("button", { name: "End session" }).click();
    await page.getByRole("dialog", { name: "Before you go" }).getByTestId("workflow-end-submit").click();
    await expect(panel).toContainText("Ended");
    await openChatPanel(page, "Outputs");
    // #173: the "Session ended" tone toast may still show above the sheet's scrim; its opaque base keeps it ≥4.5:1
    const ended = page.getByRole("status").filter({ hasText: "Session ended" });
    const toastUp = (await ended.count()) > 0;
    await panel.getByTestId("workflow-drive-open").click();
    await expect(page.getByRole("dialog", { name: "Save to Google Drive?" })).toBeVisible();
    await axe(toastUp ? "drive confirm (toast over scrim)" : "drive confirm");
    await zoom();
    await page.getByRole("dialog", { name: "Save to Google Drive?" }).getByRole("button", { name: "Cancel" }).click();
  } finally {
    await page.request.delete("/api/integrations/drive", { headers: H });
    await page.request.delete("/api/bible", { headers: H });
  }
});

test("agents + coordinator (Work from Jarvis 2): axe clean and no overflow at 200% text zoom (item agent panel, map strip, coordinator pane)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const post = async (data: unknown) => {
    const r = await page.request.post("/api/work/items", { data, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const areaId = await post({ kind: "area", title: `Zoom sandpiper ${nonce}` });
  const id = await post({ kind: "thread", parentId: areaId, title: `Zoom turnstone with a fairly long name ${nonce}` });
  const p = await page.request.patch(`/api/work/items/${id}`, { data: { assignee: "agent:momentumchief" }, headers: { "x-jarvis-csrf": "1" } });
  expect(p.ok(), await p.text()).toBeTruthy();
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
        label,
      )
      .toEqual([]);
  };
  await page.goto(`/areas?item=${id}`);
  await expect(page.getByTestId("item-agent-panel")).toBeVisible();
  await axe("item agent panel");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });

  await page.goto("/areas");
  const card = page.getByTestId("map-area-card").filter({ hasText: `Zoom sandpiper ${nonce}` });
  await page.getByRole("listitem").filter({ has: card }).getByTestId("coordinator-open").click();
  const pane = page.getByTestId("coordinator-pane");
  await pane.getByTestId("coordinator-catch-up").click();
  await expect(pane.getByTestId("coordinator-input")).toHaveValue(/Catch me up/);
  await axe("coordinator pane");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await page.keyboard.press("Escape");
});

test("a11y + 200% text: area page (project cards, tree, coordinator column/sheet)", async ({ page }) => {
  await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemo }));
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemoDecisions }));
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: agentRunsDemo }));
  await page.route(/\/api\/work\/items\/ma_j$/, (route) => route.fulfill({ json: mapDemoAreaDetail }));
  await page.route(/\/api\/work\/items\/[^/]+\/coordinator(?:\?.*)?$/, (route) => route.fulfill({ json: coordinatorDemo }));
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: { items: mapDemo.items } }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], conversations: [], conversationsTotal: 0, unavailable: [], count: 0 } }),
  );
  await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
  await page.goto("/areas?item=ma_j");
  await expect(page.getByTestId("area-project-card")).toHaveCount(2);
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect
      .soft(
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} ${n.failureSummary ?? ""}`).join(" ")}`),
        label,
      )
      .toEqual([]);
  };
  await axe("area page");
  const wide = (page.viewportSize()?.width ?? 0) >= 1280;
  if (wide) {
    await expect(page.getByTestId("area-coordinator").getByTestId("area-discussions")).toContainText("Plan the areas merge");
  } else {
    await page.getByTestId("area-coordinator-sheet-open").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByTestId("area-discussions")).toContainText("Plan the areas merge");
    await axe("area coordinator sheet");
    await page.keyboard.press("Escape");
  }
  await page.getByRole("group", { name: "Area view" }).getByRole("button", { name: "Tree" }).click();
  await expect(page.getByTestId("area-tree").getByText("depends on")).toBeVisible();
  await axe("area tree");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
});

test("a11y + 200% text: item Agent panel with a delegation (children, copyable transcript, Stalled)", async ({ page }) => {
  const d = itemDetailVisual;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
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
        id: "arun_a1",
        title: "Shelf bracket research with a deliberately long title that has to wrap",
        state: "running",
        summary: "Two of three sub-agents done.",
        delegationId: "deleg_shelf_0123456789abcdef",
        hermesSessionId: "20261104_120000_abcdef",
        transcriptPath: "/opt/data/delegations/deleg_shelf_0123456789abcdef/a-very-long-transcript-file-name.md",
        children: [{ title: "Bracket load ratings", state: "done", summary: "75 lb per pair on studs." }],
        startedAt: ago(20),
        updatedAt: ago(2),
      },
      { ...base, id: "arun_a2", title: "Paint colour options", state: "running", startedAt: ago(120), updatedAt: ago(90) },
    ],
  };
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: { [d.item.id]: info }, active: [info] } }));
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route(/\/api\/work\/items(?:\?.*)?$/, (route) => route.fulfill({ json: areasVisual }));
  await page.route(new RegExp(`/api/work/items/${d.item.id}$`), (route) => route.fulfill({ json: d }));
  await page.route(/\/api\/work\/overview(?:\?.*)?$/, (route) => route.fulfill({ json: { ...mapDemo, items: areasVisual.items, links: {}, relations: {} } }));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) => route.fulfill({ json: inboxVisual }));
  await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (route) => route.fulfill({ json: { conversations: [], total: 0, unavailable: [] } }));
  await page.goto(`/areas?item=${d.item.id}`);
  const panel = page.getByTestId("item-agent-panel");
  await expect(panel.getByTestId("agent-stalled")).toHaveCount(1);
  const r = await new AxeBuilder({ page: page as never })
    .include('[data-testid="item-agent-panel"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
  ).toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
});

test("a11y + 200% text: Chief of staff rail, phone tray and sheet with quick actions", async ({ page }, info) => {
  test.setTimeout(120_000);
  // Other specs leave D-n/R-n rows behind; a failing one makes the tray open Running instead of Chat.
  await page.route(/\/api\/coordinator\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route(/\/api\/coordinator\/runs$/, (route) =>
    route.fulfill({ json: { runs: [], events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } } }),
  );
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  const quick = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
    id,
    userId: "owner",
    label,
    prompt: `${label} prompt`,
    scope: "global",
    pinned: false,
    sortOrder: 0,
    status: "active",
    source: "owner",
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
  await page.route(/\/api\/work\/coordinator\/global(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        area: { id: "gc_a11y", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: null,
        sessionTitle: null,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: mapDemoDecisions }));
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route(/\/api\/quick-actions(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        actions: [
          quick("a11yq1", "Daily brief with a fairly long label", { pinned: true }),
          quick("a11yq2", "Plan my week"),
          quick("a11yq3", "Weekly review proposal", { status: "proposed", source: "agent:chiefofstaff" }),
        ],
      },
    }),
  );
  await page.route(/\/api\/work\/activity\?actor=agent&q=chiefofstaff/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "a11ya1",
            at,
            type: "created",
            actor: { kind: "agent", name: "chiefofstaff" },
            verb: "created",
            object: { id: "a11yi1", title: "Book the furnace tune-up" },
            detail: null,
            via: "chiefofstaff",
            undoOpId: "a11yop1",
          },
        ],
        nextCursor: null,
        latestAt: at,
      },
    }),
  );
  await page.route(/\/api\/hermes\/sessions(\/.*)?$/, (route) => (route.request().method() === "GET" ? route.fallback() : route.abort()));
  const axe = async (label: string, include?: string) => {
    let builder = new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const r = await builder.analyze();
    expect
      .soft(
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} ${n.failureSummary ?? ""}`).join(" | ")}`),
        label,
      )
      .toEqual([]);
  };
  const zoom = async () => {
    const t = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(250);
    await expectNoHorizontalOverflow(page, { soft: true });
    await t.evaluate((el) => (el as Element).remove());
  };
  await page.goto("/decisions");
  if (info.project.name === "desktop") {
    const rail = page.getByRole("complementary", { name: "Chief of staff" });
    await expect(rail.getByTestId("quick-action-proposal")).toBeVisible();
    await axe("rail open", ".gc-rail");
    await zoom();
    await rail.getByRole("button", { name: "Collapse Chief of staff" }).click();
    await expect(rail).toHaveAttribute("data-open", "false");
    await axe("rail strip", ".gc-rail");
    await zoom();
    return;
  }
  const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
  await expect(page.getByTestId("quick-actions-tray")).toBeVisible();
  await axe("tray");
  await zoom();
  await tray.click();
  const sheet = page.getByRole("dialog", { name: "Chief of staff" });
  // The tray opens where its sentence points (here: the approvals under Needs you); the chat is one tab away.
  await sheet.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect(sheet.getByTestId("quick-action-proposal")).toBeVisible();
  await axe("sheet chat");
  await zoom();
  // Changes live under Activity (with runs); there is no separate tab.
  await sheet.getByRole("tab", { name: /^Activity/ }).click();
  await expect(sheet.getByRole("region", { name: "Changes" })).toBeVisible();
  await axe("sheet activity");
  await zoom();
  await page.keyboard.press("Escape");
});

test("a11y + 200% text: CW v3 Needs you list, risk-flagged decision detail and Running groups", async ({ page }, info) => {
  test.setTimeout(120_000);
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  const decision = (seq: number, question: string, extra: Record<string, unknown> = {}) => ({
    id: `dcw${seq}`,
    ref: `D-${seq}`,
    seq,
    itemId: `wk_cw${seq}`,
    itemTitle: "Quillwort release train with a fairly long item title",
    areaTitle: "Portfolio",
    runId: null,
    question,
    choices: ["Ship it now", "Wait for the next window"],
    recommended: "Ship it now",
    risk: [],
    pack: { why: "CI is green on the merge commit and the deploy lock is free.", facts: [{ label: "Path", value: "/opt/data/deployments/jarvis/deploy.sh" }] },
    defaultChoice: null,
    expiresAt: null,
    state: "open",
    answeredChoice: null,
    answeredAt: null,
    answeredVia: null,
    deferredUntil: null,
    supersededBy: null,
    raisedBy: "agent:chiefofstaff",
    createdAt: iso(40 + seq),
    updatedAt: iso(40 + seq),
    ...extra,
  });
  const decisions = [
    decision(48, "Rotate the Cloudflare API key that the tunnel uses before Friday's release window?", {
      risk: ["credential"],
      choices: ["Rotate", "Keep"],
      recommended: "Rotate",
      pack: { why: "The key was shared in a log.", evidence: [{ kind: "diff", label: "traefik.yml", text: "- key: old\n+ key: ${CF_KEY}" }] },
    }),
    decision(49, "Renumber migration 0042 so the Phase 4 train can merge?"),
    decision(50, "Ship the sedge ledger?"),
  ];
  const run = (seq: number, state: string, extra: Record<string, unknown> = {}) => ({
    id: `rcw${seq}`,
    ref: `R-${seq}`,
    seq,
    itemId: "wk_cw48",
    itemTitle: "Quillwort release train",
    profile: "devchief",
    title: `Lane ${seq}: hotfix chat send while four lanes run with a long title`,
    state,
    stalled: false,
    summary: "Running the e2e suite",
    prUrl: null,
    parentRunId: null,
    parentRef: null,
    pipeline: [
      { stage: "build", state: "ok" },
      { stage: "ci", state: state === "failed" ? "failed" : "running" },
    ],
    lock: null,
    interruptedAt: state === "interrupted" ? iso(30) : null,
    startedAt: iso(90),
    updatedAt: iso(5 + seq),
    finishedAt: null,
    noticeCount: 2,
    ...extra,
  });
  const runs = [run(65, "failed"), run(66, "running"), run(67, "interrupted"), run(68, "running", { parentRunId: "rcw66", parentRef: "R-66" })];
  await page.route(/\/api\/coordinator\/decisions(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { decisions, counts: { open: decisions.length, deferred: 0 } } }),
  );
  await page.route(/\/api\/coordinator\/runs$/, (route) =>
    route.fulfill({ json: { runs, events: [], lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route(/\/api\/coordinator\/looked$/, (route) =>
    route.fulfill({ json: { lastLooked: { chat: null, needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route(/\/api\/coordinator\/decisions\/.+\/(answer|defer)$/, (route) => route.fulfill({ status: 409, json: { error: "Not part of this test" } }));
  await page.route(/\/api\/hermes\/sessions(\/.*)?$/, (route) => (route.request().method() === "GET" ? route.fallback() : route.abort()));
  const axe = async (label: string, include: string) => {
    // Let the detail's push-in (opacity) animation finish: mid-fade colours fail color-contrast.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(include).analyze();
    expect
      .soft(
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} ${n.failureSummary ?? ""}`).join(" | ")}`),
        label,
      )
      .toEqual([]);
  };
  const zoom = async () => {
    const t = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(250);
    await expectNoHorizontalOverflow(page, { soft: true });
    await t.evaluate((el) => (el as Element).remove());
  };
  await page.goto("/more");
  const desktop = info.project.name === "desktop";
  const scope = desktop ? page.getByRole("complementary", { name: "Chief of staff" }) : page.getByRole("dialog", { name: "Chief of staff" });
  const sel = desktop ? ".gc-rail" : ".gc-sheet";
  // The tray is one button; its status sentence says what waits. Needs you is a tab inside.
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await scope.getByRole("tab", { name: /^Needs you/ }).click();
  await expect(scope.getByRole("button", { name: "D-49: Ship it now (recommended)", exact: true })).toBeVisible();
  // A risky decision offers no one-tap chips: its row opens the card.
  await expect(scope.getByRole("button", { name: /^D-48: / })).toHaveCount(0);
  await axe("needs list", sel);
  await zoom();
  await scope.getByRole("button", { name: /^Open decision D-48:/ }).click();
  const answers = scope.getByRole("group", { name: "Answers for D-48" });
  await expect(answers).toBeVisible();
  // A risky choice arms first; the in-place Confirm is what would send it.
  await answers.getByRole("button", { name: /^Rotate/ }).click();
  await expect(scope.getByRole("group", { name: "Confirm answer" })).toBeVisible();
  await axe("risk-flagged detail", sel);
  await zoom();
  await scope.getByRole("tab", { name: /^Activity/ }).click();
  await expect(scope.getByText(/Lane 65/)).toBeVisible();
  await axe("activity", sel);
  await zoom();
});

test("alder settings appearance + sub-page section nav: one h1, current section and 200% reflow", async ({ page }) => {
  await stubPhase3Settings(page);
  await page.goto("/settings");
  await expect(page.getByRole("radiogroup", { name: "Theme", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Compact", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await page.getByRole("radio", { name: "System", exact: true }).click();
  await page.getByRole("radio", { name: "Auto", exact: true }).click();
  // The section nav is a container query (page ≥ 720 px): at 1280 the Chief of staff rail leaves less, so check it on a wide desktop.
  if ((page.viewportSize()?.width ?? 0) >= 1024) await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/settings/agents");
  await expect(page.getByRole("heading", { name: /^Coordinators/ })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  const nav = page.locator('nav[aria-label="Settings sections"]');
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Agents", exact: true })).toHaveAttribute("aria-current", "page");
  } else await expect(nav).toBeHidden();
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page);
  const results = await new AxeBuilder({ page: page as never }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
});

test("Prismv2 dynamic review sheet/panel: WCAG22AA + 200% text reflow", async ({ page }, testInfo) => {
  await stubPrismV2(page);
  await page.goto("/more");
  if (testInfo.project.name === "desktop") await page.locator(".gc-priority").getByRole("button", { name: "Fill in", exact: true }).click();
  else {
    // Tap only once the tray shows the card line: an earlier tap opens the sheet without the card.
    const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
    await expect(tray).toContainText("Weekly review");
    await tray.click();
  }
  await expect(page.getByTestId("dynamic-card")).toBeVisible();
  const selector = testInfo.project.name === "desktop" ? ".gc-rail" : ".gc-sheet";
  const result = await new AxeBuilder({ page: page as never }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page);
  expect(await page.getByTestId("dynamic-card").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("scheduled jobs and edit dialog: axe + 200% text", async ({ page }) => {
  await stubPhase3Settings(page);
  await page.route("**/api/agents/schedules", (route) => route.fulfill({ json: schedulesFixture() }));
  await page.goto("/settings/agents#schedules");
  const schedules = page.locator("#schedules");
  await expect(schedules.getByText("Lantern morning check", { exact: true })).toBeVisible();
  const cardResult = await new AxeBuilder({ page: page as never }).include("#schedules").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(cardResult.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await schedules.getByRole("button", { name: "New job", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New scheduled job" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Job enabled" })).not.toBeChecked();
  const result = await new AxeBuilder({ page: page as never }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page, { soft: true });
  expect.soft(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("while away ledger: axe + 200% text", async ({ page }) => {
  await page.route("**/api/agents/away", (route) => route.fulfill({ json: awayFixture() }));
  await page.goto("/home");
  const card = page.locator("main").getByTestId("while-away").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "1 change", exact: true }).click();
  const result = await new AxeBuilder({ page: page as never })
    .include('main [data-testid="while-away"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page, { soft: true });
  expect.soft(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("feedback inbox and rate dialogs: axe clean and reflow at 200% text zoom", async ({ page }) => {
  await page.route(/\/api\/feedback(\?.*)?$/, (route) => {
    const sid = new URL(route.request().url()).searchParams.get("sessionId");
    return route.fulfill({ json: sid ? { ...feedbackVisual(), entries: [] } : feedbackVisual() });
  });
  const axe = async (include?: string) => {
    const b = new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
    const results = await (include ? b.include(include) : b).analyze();
    expect(
      results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  };
  const zoomed = async () => {
    const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expectNoHorizontalOverflow(page);
    await zoom.evaluate((el) => (el as Element).remove());
  };
  await page.goto("/feedback");
  await expect(page.getByTestId("feedback-row")).toHaveCount(3);
  await axe();
  await zoomed();
  await page.goto("/chat/sess_morning");
  const bubble = page.locator('[data-testid="msg-bubble"][data-who="assistant"]').first();
  await expect(bubble).toBeVisible();
  await bubble.click({ position: { x: 4, y: 4 } });
  await bubble
    .locator("xpath=..")
    .getByRole("button", { name: /^Bad response/ })
    .click();
  await expect(page.getByRole("dialog", { name: "What went wrong?" })).toBeVisible();
  await axe('[role="dialog"]');
  await zoomed();
  await page.getByRole("dialog").getByRole("button", { name: "Ask to fix…" }).click();
  await expect(page.getByRole("dialog", { name: "Ask to fix" })).toBeVisible();
  await axe('[role="dialog"]');
  await zoomed();
  await page.keyboard.press("Escape");
});

// #257: real prod data (an agent's 81-character decision choice) widened every phone page to 445 px, so the
// fixed coordinator tray filled the wider layout viewport and its composer sat off-screen. Mobile emulation
// WIDENS innerWidth/clientWidth when a page overflows, so compare against the configured viewport instead.
test("phone width guard: long real-shaped data never widens key pages past the viewport", async ({ page }, testInfo) => {
  const vw = page.viewportSize()!.width;
  test.skip(vw > 700, "phone layouts only");
  test.setTimeout(120_000);
  const long = "Urgent/blocking: fold the stalled mirror cleanup into the next release train before anything else";
  const url = "https://github.com/NickBolles/Personal-dashboard/pull/123456789?diff=split&w=1#discussion_r1234567890abcdef";
  const unbroken = "Supercalifragilisticexpialidocious_area_title_without_any_spaces_at_all_0123456789";
  const at = new Date().toISOString();
  const entries = [
    {
      key: "item:mi_long",
      kind: "item",
      title: `${unbroken} item`,
      // Short enough to be read whole on the row, so the row offers its (long) choices as chips; the approval
      // below carries the unbreakable URL in its headline.
      question: "Which option should we take?",
      choices: [long, `Fold into run cards and drop the separate list ${url}`, "Later"],
      href: "/areas?item=mi_long",
      at,
      itemId: "mi_long",
      areaTitle: unbroken,
      sessionId: null,
      ref: "D-900",
      recommended: null,
      risk: [],
      pack: {},
    },
    {
      key: "approval:r_long",
      kind: "approval",
      title: `Hermes needs your approval: ${unbroken}`,
      question: `Run ${url}`,
      choices: [],
      href: "/chat/sess_demo",
      at,
    },
    { key: "stalled:a_long", kind: "stalled", title: `Stalled: ${unbroken}`, question: long, choices: [], href: "/areas?item=mi_long", at },
  ];
  await page.route(/\/api\/work\/decisions(?:\?.*)?$/, (route) => route.fulfill({ json: { count: 987654, entries } }));
  const offenders: string[] = [];
  for (const path of ["/home", "/areas", "/decisions", "/chat", "/resume"]) {
    await page.goto(path);
    if (path !== "/chat" && path !== "/resume") await expect(page.getByText(long, { exact: true }).first()).toBeVisible();
    else await expect(page.locator("main").first()).toBeVisible();
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => ({ iw: innerWidth, sw: document.documentElement.scrollWidth }));
    if (r.iw > vw || r.sw > vw) offenders.push(`${path}: innerWidth ${r.iw}, scrollWidth ${r.sw} > ${vw}`);
  }
  expect(offenders, `${testInfo.project.name}: pages wider than the phone viewport`).toEqual([]);
});
