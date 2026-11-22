import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, mock, setHa } from "./helpers";

/**
 * Daily brief (docs/brief.md) against the mock Hermes: the rules brief with AI
 * off, turning the AI brief on, a build, a correction that reaches the next
 * build, keeping what Jarvis noticed, and Undo. Leaves AI and the brief off so
 * other specs see the usual Home.
 */

async function api<T = unknown>(page: Page, method: "get" | "post" | "put" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const r = await page.request[method](path, { data: data ?? (method === "get" ? undefined : {}), headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

async function serious(page: Page) {
  // The brief arrives top to bottom, and a section added later (In the works) fades in too: check it once every
  // section has landed (a fading section reads as low contrast).
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="brief"] > *')].every((el) => getComputedStyle(el).opacity === "1"));
  const results = await new AxeBuilder({ page: page as never }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 3)
          .join(" | ")}`,
    );
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, request }) => {
  await mock(request, "/reset");
  await setHa(request, "cover.garage_door", "closed");
  await api(page, "delete", "/api/brief/profile");
  await api(page, "put", "/api/brief/settings", { ai: false });
  // An earlier attempt that failed midway may have left an agent request open: take it back so a retry starts clean.
  const left = await api<{ improve?: { open: { id: string }[] } }>(page, "get", "/api/brief");
  for (const r of left.improve?.open ?? []) await api(page, "delete", `/api/brief/improve/${encodeURIComponent(r.id)}`);
});
test.afterEach(async ({ page }) => {
  await api(page, "put", "/api/brief/settings", { ai: false });
  await api(page, "put", "/api/settings/ai", { enabled: false });
});

test("with AI off the brief is built from Home priorities, and Home shows no brief card", async ({ page }) => {
  await page.goto("/brief");
  const brief = page.getByTestId("brief");
  await expect(brief.getByText("Built from your Home priorities")).toBeVisible();
  await expect(brief.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  // What is true right now, from Jarvis' own calendar: no model wrote it.
  await expect(brief.getByRole("list", { name: "Right now" }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Brief settings" })).toHaveAttribute("href", "/settings/brief");
  await expect(brief.getByText("AI is turned off in Settings → AI.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  // No thumbs on a rules brief: there is nothing to teach yet.
  await expect(brief.getByRole("button", { name: /^Right call/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(await serious(page)).toEqual([]);

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "Now" })).toBeVisible();
  await expect(page.getByTestId("home-brief")).toHaveCount(0);
});

test("turn it on, read it, correct it, and keep what Jarvis noticed", async ({ page }) => {
  await api(page, "put", "/api/settings/ai", { enabled: true });
  await api(page, "post", "/api/brief/notes", { text: "Deep work before 10" });
  await page.goto("/brief");
  const brief = page.getByTestId("brief");

  // Says what leaves before anything does.
  await expect(page.getByText(/Finance and AI-excluded areas are never sent/)).toBeVisible();
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(brief.getByText("Written by Jarvis")).toBeVisible({ timeout: 30_000 });
  // On a second attempt the same day, the earlier attempt's brief shows at once while the new build is still
  // running, and would be replaced under the steps below. Wait for the build to land, then read the page fresh.
  await expect.poll(async () => (await api<{ build: { state: string } }>(page, "get", "/api/brief")).build.state, { timeout: 30_000 }).toBe("idle");
  await page.reload();
  await expect(brief.getByText("Written by Jarvis")).toBeVisible();
  await expect(brief.getByRole("heading", { name: "Protect the morning for the one thing that moves this week" })).toBeVisible();

  // One primary action on the page: opening the first pick.
  await expect(page.locator("main .k-btn-primary")).toHaveCount(1);
  // A written card says what it rests on; the unknown card kind from the mock is not shown.
  await expect(brief.getByText(/From your note “Deep work before 10”/).first()).toBeVisible();

  // The page runs Today, Next up, Insights, Initiatives, Coming up.
  const order = await brief.locator("h2.brief-h").allInnerTexts();
  const places = ["Today", "Next up", "Insights", "Initiatives", "Coming up"].map((h) => order.findIndex((o) => o.toLowerCase() === h.toLowerCase()));
  expect(places.every((n) => n >= 0)).toBe(true);
  expect([...places].sort((a, b) => a - b)).toEqual(places);

  // Insights, about the person: an honest take with a way back and a question to answer, an idea, and something noticed.
  const insights = page.getByTestId("brief-insights");
  const callout = insights.getByRole("article").filter({ hasText: "Honest take" });
  await expect(callout.getByRole("heading", { name: "You said this matters. The week does not show it." })).toBeVisible();
  // Its small steps are folded, so one long card does not stretch the row.
  await expect(callout.getByRole("listitem")).toHaveCount(0);
  await callout.getByRole("button", { name: /^3 steps/ }).click();
  await expect(callout.getByRole("listitem")).toHaveText(["Block one evening for it now", "Tell the person it involves", "ignored fourth step"]);
  await expect(callout.getByText("What got in the way?", { exact: true })).toBeVisible();
  await expect(callout.getByRole("link", { name: "Answer: What got in the way?" })).toHaveAttribute("href", /^\/chat\?new=1&context=/);
  // A small step can be ticked off, and stays ticked.
  const step = callout.getByRole("checkbox", { name: "Tell the person it involves" });
  // Wait for the save before reloading: a reload cancels a request still in flight and the tick would be lost.
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/brief/steps") && r.ok()), step.check()]);
  await page.reload();
  await callout.getByRole("button", { name: /^1 of 3 done/ }).click();
  await expect(step).toBeChecked();
  await step.uncheck();
  await expect(step).not.toBeChecked();
  const idea = insights.getByRole("article").filter({ hasText: "Idea" });
  await idea.getByRole("button", { name: /^2 steps/ }).click();
  await expect(idea.getByRole("listitem")).toHaveCount(2);
  await expect(brief.getByRole("heading", { name: "You sound lighter than last month" })).toBeVisible();
  // An observation with nothing behind it never reaches the page.
  await expect(brief.getByText("An ungrounded guess")).toHaveCount(0);
  await expect(brief.getByText("dropped by Jarvis")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(await serious(page)).toEqual([]);

  // A wrong call asks what was off, and can be undone.
  const then = brief.locator(".brief-path > li:not([data-current])").first();
  const down = then.getByRole("button", { name: /^Wrong call/ });
  await down.click();
  await expect(page.getByRole("status").filter({ hasText: "Noted: wrong call" })).toBeVisible();
  await page.getByRole("textbox", { name: /^What was off about/ }).fill("Not before Friday's review");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(then.getByText("You said: Not before Friday's review")).toBeVisible();
  await expect(down).toHaveAttribute("aria-pressed", "true");

  // A second correction, then a rebuild: the next brief cites the feedback and proposes a note.
  await brief
    .getByRole("button", { name: /^Wrong call/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Rewrite the brief with what’s true now" }).click();
  await expect(brief.getByRole("heading", { name: "You corrected me yesterday" })).toBeVisible({ timeout: 30_000 });
  await expect(brief.getByText(/From your feedback on \d{4}-\d{2}-\d{2}/)).toBeVisible();

  const notes = async () => (await api<{ notes: { state: string }[] }>(page, "get", "/api/brief/notes")).notes.map((n) => n.state).sort();
  const proposal = page.getByRole("group", { name: "Jarvis noticed" });
  await expect(proposal.getByText("Marked morning picks right on two briefs.")).toBeVisible();
  await expect(proposal.getByText("Driver", { exact: true })).toBeVisible();
  await proposal.getByRole("button", { name: /^Keep/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Kept" })).toBeVisible();
  await expect(proposal).toHaveCount(0);
  expect(await notes()).toEqual(["active", "active"]);
  // Undo puts it back as a proposal: nothing is used until it is kept.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(proposal).toBeVisible();
  expect(await notes()).toEqual(["active", "proposed"]);
  // The page is the brief: no form to fill in, no instructions.
  await expect(brief.getByRole("textbox")).toHaveCount(0);

  // 200% text still reflows.
  const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page);
  await zoom.evaluate((el) => (el as Element).remove());

  // With the AI brief on, Home is the brief.
  await page.goto("/home");
  await expect(brief.getByRole("heading", { name: "Protect the morning for the one thing that moves this week" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator("main .k-btn-primary")).toHaveCount(1);

  // Everything that is not a pick sits in rows of cards. Next up holds what is urgent and what waits on a decision.
  const next = page.getByTestId("brief-row-next");
  await expect(next.getByRole("group", { name: /^Urgent, 1 of \d$/ })).toHaveCount(1);
  await expect(next.locator(".brief-deck-top")).not.toHaveCount(0);
  // Insights is a carousel: it scrolls itself, never the page.
  const track = insights.getByRole("group", { name: "Insights: swipe or use the arrow keys" });
  expect(await track.evaluate((el) => el.scrollLeft)).toBe(0);
  await track.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page);
  expect(await serious(page)).toEqual([]);

  // The sparkle: on a task an agent can look into, one tap starts it. The row says how it stands and opens the conversation.
  const spark = brief.locator(".brief-spark").first();
  await expect(spark).toBeVisible();
  const what = (await spark.innerText()).split(":")[0]!.trim();
  expect(["Find how to book", "Find who to call", "Find the steps"]).toContain(what);
  await spark.click();
  const asked = brief.locator(".brief-asked").first();
  await expect(asked.getByRole("link")).toHaveAttribute("href", /^\/chat\//);
  await expect(page.getByTestId("brief-works").getByRole("link")).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  expect(await serious(page)).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(brief.locator(".brief-asked")).toHaveCount(0);
  await expect(page.getByTestId("brief-works")).toHaveCount(0);

  // Improve: say what should change and an agent takes it. It shows under "In the works" and Undo takes it back.
  await page.getByRole("button", { name: "Improve the brief" }).click();
  const dialog = page.getByRole("dialog", { name: "Improve the brief" });
  await expect(dialog.getByRole("button", { name: "Start agent" })).toBeDisabled();
  await dialog.getByLabel("What should change?").fill("Add friend notes. Keep what to ask each friend about.");
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(dialog).toHaveCount(0);
  const works = page.getByTestId("brief-works");
  await expect(works.getByRole("link", { name: /Add friend notes/ })).toHaveAttribute("href", /^\/chat\//);
  await expectNoHorizontalOverflow(page);
  expect(await serious(page)).toEqual([]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(works).toHaveCount(0);

  // The ranked list is one tap away, and leads back.
  await page.getByRole("link", { name: "List view" }).click();
  await expect(page).toHaveURL(/\/home\?view=list$/);
  await expect(page.getByRole("heading", { name: "Now" })).toBeVisible();
  const door = page.getByTestId("home-brief");
  await expect(door).toContainText("Protect the morning for the one thing that moves this week");
  await door.click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(brief).toBeVisible();
});

test("settings list what it knows, with export, import and a confirmed reset", async ({ page }) => {
  await api(page, "post", "/api/brief/notes", { text: "Workouts matter more than inbox zero" });
  await page.goto("/settings/brief");
  await expect(page.getByRole("heading", { level: 1, name: "Brief" })).toBeVisible();
  const notes = page.getByRole("list", { name: "Notes Jarvis uses" });
  await expect(notes.getByText("Workouts matter more than inbox zero", { exact: true })).toBeVisible();
  await expect(page.getByText("Never Finance or AI-excluded areas")).toBeVisible();
  await expect(page.getByText("Teach it something")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(await serious(page)).toEqual([]);

  const exported = await api<{ kind: string; notes: { text: string }[] }>(page, "get", "/api/brief/profile");
  expect(exported).toMatchObject({ kind: "jarvis-brief-profile", notes: [{ text: "Workouts matter more than inbox zero" }] });

  await expect(page.getByRole("switch", { name: "Hermes’ memory of me" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Cycle through the cards" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Calendar" }).click();
  await expect
    .poll(async () => (await api<{ settings: { share: { calendar: boolean } } }>(page, "get", "/api/brief/settings")).settings.share.calendar)
    .toBe(false);
  await api(page, "put", "/api/brief/settings", { share: { calendar: true } });

  // Forgetting one note asks first, and Undo puts it back.
  await notes.getByRole("button", { name: /^Forget/ }).click();
  const one = page.getByRole("dialog", { name: "Forget this note?" });
  await expect(one).toContainText("Workouts matter more than inbox zero");
  expect(await serious(page)).toEqual([]);
  await one.getByRole("button", { name: "Cancel" }).click();
  await expect(notes.getByText("Workouts matter more than inbox zero", { exact: true })).toBeVisible();
  await notes.getByRole("button", { name: /^Forget/ }).click();
  await one.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(one).toHaveCount(0);
  await expect(page.getByText("No notes yet.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(notes.getByText("Workouts matter more than inbox zero", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Importing asks first, and Undo takes the whole import back.
  await page.getByLabel("Import brief notes").setInputFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ kind: "jarvis-brief-profile", version: 1, notes: [{ text: "Family dinner is not movable" }] })),
  });
  const incoming = page.getByRole("dialog", { name: "Import 1 note?" });
  await expect(incoming).toContainText("notes.json");
  expect(await serious(page)).toEqual([]);
  await incoming.getByRole("button", { name: "Import", exact: true }).click();
  await expect(incoming).toHaveCount(0);
  await expect(notes.getByText("Family dinner is not movable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(notes.getByText("Family dinner is not movable", { exact: true })).toHaveCount(0);
  await expect(notes.getByText("Workouts matter more than inbox zero", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import, export or reset notes" }).click();
  await page.getByRole("menuitem", { name: "Forget everything…" }).click();
  const dialog = page.getByRole("dialog", { name: "Forget everything the brief knows?" });
  await expect(dialog).toContainText("Briefs already written stay.");
  await dialog.getByRole("button", { name: "Forget everything" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("No notes yet.")).toBeVisible();
  // The reset is undoable like every other write here.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(notes.getByText("Workouts matter more than inbox zero", { exact: true })).toBeVisible();
});
