import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ensureWorkflowActive, expectNoHorizontalOverflow, mock, startConversation } from "./helpers";
import { forceSourceState, SOURCE_STATES } from "./fixtures/states";
import { PHOTO_PNG } from "./fixtures/chat-files";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";

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
  "/areas/activity",
  "/capture",
  "/settings/ai",
  "/settings/agents",
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

test("200% text zoom does not cause horizontal scrolling", async ({ page }) => {
  for (const path of [
    "/home",
    "/chat/sess_morning",
    "/alerts",
    "/settings",
    "/todos",
    "/home-control",
    "/settings/people",
    "/workouts",
    "/finance",
    "/finance/plan",
    "/workflows",
    "/areas/activity",
  ]) {
    await page.goto(path);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    // Soft: report every overflowing page in one run instead of stopping at the first.
    await expectNoHorizontalOverflow(page, { soft: true });
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
  expect.soft(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
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
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id),
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
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id),
        path,
      )
      .toEqual([]);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page, { soft: true });
  };
  await check("/workflows/new", "New workflow");
  await check("/workflows/zoombuild/edit", "Edit Zoom builder");
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
        r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id),
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
  await expect(panel).toContainText("Zed Quill");
  await axe("run panel");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.waitForTimeout(200);
  await expectNoHorizontalOverflow(page, { soft: true });
  await panel.getByRole("button", { name: "End session" }).click();
  await expect(panel).toContainText("Ended");
});
