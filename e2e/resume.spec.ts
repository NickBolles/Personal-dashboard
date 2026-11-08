import { expect, test } from "@playwright/test";
import type { ResumeResponse } from "../lib/resume";
import { expectNoHorizontalOverflow } from "./helpers";
import { localDate } from "../lib/time";

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
      {
        ...conversation,
        key: "unfiled",
        sessionId: "resume_unfiled",
        title: "A thought to file",
        unfiled: true,
        path: null,
        parentId: null,
        itemHref: null,
        href: "/chat/resume_unfiled",
      },
    ],
    counts: { running: 1, waiting: 1, unread: 1, unfiled: 1 },
    conversationsUnavailable: false,
    fetchedAt: at,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/work/resume", (route) => route.fulfill({ json: resumeFixture() }));
});

test("In flight groups work and conversations with exact resume and filing destinations", async ({ page }) => {
  await page.goto("/resume");
  await expect(page.getByRole("heading", { level: 1, name: "In flight", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("resume-row")).toHaveCount(5);
  await expect(page.getByRole("heading", { name: /^Needs you \/ running\s*2$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Conversations\s*2$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Unfiled\s*1$/ })).toBeVisible();
  const fixture = resumeFixture();
  for (const row of [...fixture.runs, ...fixture.conversations]) {
    const item = page.getByTestId("resume-row").filter({ hasText: row.title });
    await expect(item.getByRole("link", { name: "Resume", exact: true })).toHaveAttribute("href", row.href);
  }
  await expect(page.getByRole("img", { name: "Waiting for you" })).toBeVisible();
  await expect(page.getByText("2 unread", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "File…", exact: true })).toHaveAttribute("href", "/inbox");
  await expectNoHorizontalOverflow(page);
});

test("Segmented filters use URL state, retain selection on reload and hide empty sections", async ({ page }) => {
  await page.goto("/resume");
  await expect(page.getByTestId("resume-row")).toHaveCount(5);
  const filter = page.getByRole("radiogroup", { name: "In flight view" });
  await filter.getByRole("radio", { name: "Running", exact: true }).click();
  await expect(page).toHaveURL(/\/resume\?view=running$/);
  await expect(page.getByTestId("resume-row")).toHaveCount(1);
  await expect(page.getByTestId("resume-row")).toContainText("Verify navigation");
  await expect(page.getByRole("heading", { name: /^Conversations/ })).toHaveCount(0);
  await filter.getByRole("radio", { name: "Unread", exact: true }).click();
  await expect(page.getByTestId("resume-row")).toHaveCount(1);
  await expect(page.getByTestId("resume-row")).toContainText("Navigation review");
  await filter.getByRole("radio", { name: "Unfiled", exact: true }).click();
  await expect(page).toHaveURL(/view=unfiled$/);
  await expect(page.getByTestId("resume-row")).toContainText("A thought to file");
  await page.reload();
  await expect(filter.getByRole("radio", { name: "Unfiled", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("resume-row")).toHaveCount(1);
  await filter.getByRole("radio", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/\/resume$/);
  await expect(page.getByTestId("resume-row")).toHaveCount(5);
});

test("Today strip picks up the first three rows and links to the full hub", async ({ page }) => {
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

test("populated hub reflows at 320px and 200% text zoom with phone action targets", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/resume");
  await expect(page.getByTestId("resume-row")).toHaveCount(5);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page);
  for (const link of await page.getByTestId("resume-row").getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});
