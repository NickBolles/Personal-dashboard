import { expect, test } from "@playwright/test";
import type { ResumeResponse } from "../lib/resume";
import { expectNoHorizontalOverflow } from "./helpers";
import { stubTasks } from "./fixtures/tasks";
import { localDate } from "../lib/time";

/** Today's "Pick up where you left off" strip still reads the resume hub's rows. */
function resumeFixture(): ResumeResponse {
  const todayCT = localDate(new Date(), "America/Chicago");
  const at = `${todayCT}T14:05:00Z`;
  const run = { kind: "run" as const, path: "General Dev › Jarvis › Resume hub", approval: false, stalled: false, who: "@devchief", at };
  const conversation = {
    kind: "conversation" as const,
    preview: null,
    path: "General Dev › Jarvis",
    parentId: "resume_project",
    unfiled: false,
    unread: false,
    unreadCount: null,
    agentProfile: "devchief",
    at,
    itemHref: "/areas?item=resume_project",
  };
  return {
    runs: [
      {
        ...run,
        key: "waiting",
        itemId: "resume_waiting",
        title: "Review the resume hub",
        live: "waiting",
        approval: true,
        href: "/chat/resume_waiting",
        itemHref: "/areas?item=resume_waiting",
        sessionId: "resume_waiting",
      },
      {
        ...run,
        key: "running",
        itemId: "resume_running",
        title: "Verify navigation",
        live: "running",
        href: "/chat/resume_running",
        itemHref: "/areas?item=resume_running",
        sessionId: "resume_running",
      },
    ],
    conversations: [
      { ...conversation, key: "unread", sessionId: "resume_unread", title: "Navigation review", unread: true, unreadCount: 2, href: "/chat/resume_unread" },
      { ...conversation, key: "recent", sessionId: "resume_recent", title: "Plan the next iteration", href: "/chat/resume_recent" },
    ],
    counts: { running: 1, waiting: 1, unread: 1, unfiled: 0 },
    conversationsUnavailable: false,
    fetchedAt: at,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/work/resume", (route) => route.fulfill({ json: resumeFixture() }));
  await stubTasks(page, Date.now());
});

test("In flight lists one row per task by channel: state with its reason, the title, then the latest activity", async ({ page }) => {
  await page.goto("/resume");
  await expect(page.getByRole("heading", { level: 1, name: "In flight", exact: true })).toHaveCount(1);
  const rows = page.getByTestId("task-row");
  await expect(rows).toHaveCount(4);
  // Channels with something needing you come first; inside one: Needs you, Failed, Stalled, Working.
  await expect(page.getByTestId("task-group").nth(0)).toHaveAccessibleName("Home");
  await expect(rows.nth(0)).toContainText("Needs you");
  await expect(rows.nth(1)).toContainText(/Stalled · no word since/);
  await expect(rows.nth(2)).toContainText("Failed");
  await expect(rows.nth(3)).toContainText(/Working · 6m · @devchief/);
  // The title opens the task on its Overview.
  await expect(rows.nth(3).getByRole("link", { name: "Reconcile the storefront inventory export" })).toHaveAttribute("href", "/areas?item=task_inventory");
  // A question with two short choices offers them under the title; its number stays as a chip.
  const asking = rows.nth(0);
  await expect(asking.getByRole("img", { name: "Decision D 52" })).toBeVisible();
  await expect(asking.getByRole("button", { name: "$350", exact: true })).toBeVisible();
  await expect(asking.getByRole("button", { name: "$300", exact: true })).toBeVisible();
  // Icon actions in a fixed order: Steer, then Stop or Retry.
  const working = rows.nth(3);
  const names = await working.getByRole("button").evaluateAll((els) => els.map((el) => el.textContent?.trim() || el.getAttribute("aria-label") || ""));
  expect(names.filter((n) => /^(Steer|Stop|Retry|Resume) /.test(n)).map((n) => n.split(" ")[0])).toEqual(["Steer", "Stop"]);
  await expect(rows.nth(2).getByRole("button", { name: /^Retry / })).toBeVisible();
  await expect(rows.nth(1).getByRole("button", { name: /^Resume / })).toBeVisible();
  // No run number appears on a row or anywhere else in the list.
  await expect(page.getByTestId("task-list")).not.toContainText(/\bR-\d+\b/);
  // Finished and unreviewed work is one row with a count and the oldest age; so is what closed since the last look.
  await expect(page.getByTestId("review-row")).toContainText("Ready for review · 2");
  await expect(page.getByTestId("review-row")).toContainText("Across 2 projects · oldest 9 days");
  await expect(page.getByTestId("review-row").getByRole("link")).toHaveAttribute("href", "/resume/review");
  await expect(page.getByTestId("done-row")).toContainText("Done since you looked · 3");
  await expectNoHorizontalOverflow(page);
});

test("the activity line opens the timeline in place, newest first, each line with its type and time", async ({ page }) => {
  await page.goto("/resume");
  const row = page.getByTestId("task-row").filter({ hasText: "Reconcile the storefront inventory export" });
  const peek = row.getByRole("button", { name: /^Timeline for Reconcile/ });
  await expect(peek).toContainText("40 mismatches so far, all in one category");
  await expect(peek).toContainText("Matched 172 of 212 rows");
  await peek.click();
  const timeline = row.getByRole("list", { name: "Timeline for Reconcile the storefront inventory export" });
  await expect(timeline.getByRole("listitem")).toHaveCount(4);
  await expect(timeline.getByRole("listitem").nth(0)).toContainText("Progress");
  await expect(timeline.getByRole("listitem").nth(3)).toContainText("Captured");
  await expect(row.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/areas?item=task_inventory");
  // Stop asks first, in place.
  await row.getByRole("button", { name: /^Stop / }).click();
  await expect(row.getByRole("group", { name: /^Stop work on/ })).toBeVisible();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row.getByRole("group", { name: /^Stop work on/ })).toHaveCount(0);
});

test("All holds every open task by channel then project; the choice is in the URL and survives a reload", async ({ page }) => {
  await page.goto("/resume");
  const pick = page.getByRole("radiogroup", { name: "Which tasks" });
  await pick.getByRole("radio", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/\/resume\?view=all$/);
  const project = page.getByTestId("task-row").filter({ hasText: "Storefront" }).first();
  await expect(project).toContainText("Project · 3 of 10 done · 1 failed · 1 working · 1 to review");
  // A project opens in place to the tasks inside it.
  await project.getByRole("button", { name: "Tasks in Storefront" }).click();
  await expect(project.getByTestId("task-row")).toHaveCount(4);
  await expect(project.getByTestId("task-row").filter({ hasText: "Holiday sale checklist" })).toContainText("Not started · captured 3d ago");
  await page.reload();
  await expect(pick.getByRole("radio", { name: "All", exact: true })).toHaveAttribute("aria-checked", "true");
  await pick.getByRole("radio", { name: "In flight", exact: true }).click();
  await expect(page).toHaveURL(/\/resume$/);
});

test("review queue: grouped by project with the result and the pull request; several are marked reviewed behind one confirm, with Undo", async ({ page }) => {
  let posted: unknown = null;
  let undone = 0;
  await page.route("**/api/work/tasks/review", async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({
      json: {
        reviewed: [
          { id: "task_theme", opId: "op_1" },
          { id: "task_wall", opId: "op_2" },
        ],
        skipped: [],
      },
    });
  });
  await page.route(/\/api\/work\/ops\/[^/]+\/undo$/, async (route) => {
    undone++;
    await route.fulfill({ json: { itemId: "x", kind: "edit", outcome: "restored" } });
  });
  await page.goto("/resume/review");
  await expect(page.getByRole("heading", { level: 1, name: "Ready for review" })).toBeVisible();
  await expect(page.getByText("2 tasks · 2 projects")).toBeVisible();
  await expect(page.getByTestId("task-group").nth(0)).toHaveAccessibleName("Storefront");
  const first = page.getByTestId("task-row").nth(0);
  await expect(first).toContainText("Notices fold after the first line");
  await expect(first).toContainText("PR 303 · merged");
  // "Send back" opens the task's chat with the composer ready.
  await expect(first.getByRole("button", { name: /^Send back / })).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const title of ["Quieter stalled-run notices", "Measure the wall"]) await page.getByRole("button", { name: `Select ${title}` }).click();
  await page.getByRole("button", { name: "Mark 2 reviewed" }).click();
  // Nothing is closed before the confirm.
  expect(posted).toBeNull();
  const dialog = page.getByRole("dialog", { name: "Mark 2 tasks reviewed?" });
  await dialog.getByRole("button", { name: "Mark reviewed" }).click();
  await expect.poll(() => posted).toEqual({ ids: ["task_theme", "task_wall"] });
  const receipt = page.getByTestId("review-receipt");
  await expect(receipt).toContainText("2 tasks marked reviewed");
  await receipt.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => undone).toBe(2);
  await expectNoHorizontalOverflow(page);
});

test("Today strip picks up the first three rows and links to In flight", async ({ page }) => {
  await page.goto("/home");
  const strip = page.getByTestId("pick-up-strip");
  await expect(strip.getByRole("heading", { name: "Pick up where you left off" })).toBeVisible();
  await expect(strip.getByTestId("pick-up-row")).toHaveCount(3);
  const links = strip.getByRole("link", { name: "Resume", exact: true });
  for (const [i, href] of ["/chat/resume_waiting", "/chat/resume_running", "/chat/resume_unread"].entries())
    await expect(links.nth(i)).toHaveAttribute("href", href);
  await expect(strip.getByText("Plan the next iteration", { exact: true })).toHaveCount(0);
  await expect(strip.getByRole("link", { name: "See all", exact: true })).toHaveAttribute("href", "/resume");
});

test("the populated list reflows at 320px and 200% text zoom with phone action targets", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/resume");
  await expect(page.getByTestId("task-row")).toHaveCount(4);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page);
  // Icon actions keep a phone tap area; text links and buttons keep at least 24px.
  for (const button of await page
    .getByTestId("task-row")
    .getByRole("button", { name: /^(Steer|Stop|Retry|Resume) / })
    .all()) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  for (const target of await page.getByTestId("task-row").locator("a, button").all()) {
    const box = await target.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }
});
