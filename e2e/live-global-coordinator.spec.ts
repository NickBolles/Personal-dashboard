import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * The Chief of staff panel shows the run in flight: live text, and an approval that is answered right there, in the
 * rail (desktop 1280) and in the tray sheet (phone 412). The run is a real one against the mock Hermes (a real
 * conversation, a real event stream); only which conversation is the Chief of staff thread, and the panel's lists,
 * are fixtures. Hermes allows few connections, so the test counts the run's event streams: one.
 * The file name matches the desktop project's `global-coordinator.spec.ts` pattern. "Hornbeam" is unique to this spec.
 */

async function stubPanel(page: Page, sid: string) {
  const now = () => new Date().toISOString();
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: sid,
        sessionTitle: "Chief of staff",
        pinned: true,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route("**/api/work/items/portfolio/coordinator", (route) =>
    route.fulfill({ json: { areaId: "portfolio", sessionId: sid, pinned: true, previous: sid } }),
  );
  await page.route("**/api/work/decisions*", (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/work/activity**", (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/coordinator/decisions*", (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route("**/api/coordinator/runs", (route) =>
    route.fulfill({ json: { runs: [], events: [], lastLooked: { chat: now(), needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/coordinator/looked", (route) =>
    route.fulfill({ json: { lastLooked: { chat: now(), needs: null, running: null, changes: null, context: null } } }),
  );
  // The recap has its own tray line; this test is about the run.
  await page.route("**/api/agents/away", (route) =>
    route.fulfill({ json: { runs: [], since: null, line: null, counts: { ran: 0, failed: 0, changes: 0, needsYou: 0, running: 0, waiting: 0 } } }),
  );
}

test("a run in the Chief of staff panel streams there, and its approval is answered there, on one connection", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const created = await appPost(page, "/api/hermes/sessions", { title: `Hornbeam ${info.project.name} ${Date.now()}` });
  expect(created.ok(), await created.text()).toBeTruthy();
  const sid = ((await created.json()) as { id: string }).id;
  await stubPanel(page, sid);
  const streams: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^\/api\/hermes\/runs\/[^/]+\/events$/.test(url.pathname)) streams.push(url.pathname + url.search);
  });
  let polls = 0;
  let counting = false;
  page.on("request", (request) => {
    if (counting && request.method() === "GET" && new URL(request.url()).pathname === `/api/hermes/sessions/${sid}`) polls += 1;
  });

  await page.goto("/more");
  const scope = desktop ? page.getByRole("complementary", { name: "Chief of staff" }) : page.getByRole("dialog", { name: "Chief of staff" });
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await scope.getByRole("tab", { name: "Chat", exact: true }).click();

  const input = scope.getByTestId("gc-input");
  await input.fill("Hornbeam: please delete the build folder");
  await scope.getByTestId("coordinator-send").click();

  // The approval the run asks for is in the panel, not behind a link to the chat page.
  const live = scope.getByTestId("gc-live");
  const card = live.getByRole("group", { name: /needs your approval/ });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("rm -rf build");
  // While it waits the composer is one compact row and says why nothing can be sent.
  await expect(input).toHaveAttribute("placeholder", "Approve or deny first");
  await expect(scope.getByTestId("coordinator-send")).toBeDisabled();
  await expect(scope.getByText(/^Viewing:/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // The run arrives over its stream: the conversation is not polled while it does.
  counting = true;
  await page.waitForTimeout(4_000);
  counting = false;
  expect(polls).toBe(0);

  await card.getByRole("button", { name: "Approve once" }).click();
  // Approvals wait 8 s with Undo; skip the wait.
  await card.getByRole("button", { name: "Send now" }).click();
  await expect(card).toBeHidden();

  // The run finishes: its reply is in the thread once, the live copy is gone, and the composer takes a new message.
  await expect(live).toBeHidden({ timeout: 30_000 });
  await expect(
    scope
      .getByRole("list", { name: "Latest messages" })
      .getByText(/Hornbeam: please delete the build folder/)
      .first(),
  ).toBeVisible();
  await expect(input).not.toHaveAttribute("placeholder", "Approve or deny first");
  await expect(input).not.toHaveAttribute("placeholder", "Add guidance…");

  // One event stream for the run, opened once (a reconnect would carry lastSeq).
  expect(streams.filter((s) => !s.includes("lastSeq"))).toHaveLength(1);
  expect(new Set(streams.map((s) => s.split("?")[0])).size).toBe(1);
});
