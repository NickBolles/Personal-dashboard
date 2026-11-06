import { expect, test, type Page } from "@playwright/test";

/** Same browser-only coordinator fixtures as global-coordinator.spec: no real Hermes calls. */
async function stubCoordinator(page: Page) {
  await page.route("**/api/hermes/**", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 409, json: { error: "Sending is not part of this test" } });
    return route.fulfill({ json: { sessions: [], complete: true } });
  });
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
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
  await page.route("**/api/work/decisions*", (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/work/activity**", (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/work/items*", (route) => route.fulfill({ json: { items: [], linkedConversations: [] } }));
}
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phone native modal follow-ups");
  await stubCoordinator(page);
});

test("phone search shortcut closes the Chief of staff sheet and focuses the palette", async ({ page }) => {
  await page.goto("/more");
  const sheet = page.getByRole("dialog", { name: "Chief of staff" });
  const box = page.getByRole("combobox", { name: "Search Jarvis" });
  await page.getByRole("button", { name: "Chief of staff", exact: true }).click();
  await expect(sheet).toBeVisible();
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(box).toBeFocused({ timeout: 1000 });
    await expect(sheet).toBeHidden();
  }).toPass();
});

test("phone accepts a proposed quick action and can Undo without closing the sheet", async ({ page }) => {
  const at = "2026-11-07T18:00:00Z";
  let accepted = false;
  let undone = false;
  const action = {
    id: "followup-quick",
    userId: "owner",
    label: "Nebulark follow-up",
    prompt: "Inspect Nebulark",
    scope: "global",
    pinned: false,
    sortOrder: 0,
    source: "agent:chiefofstaff",
    createdAt: at,
    updatedAt: at,
  };
  await page.route(/\/api\/quick-actions(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { actions: [{ ...action, status: accepted ? "active" : "proposed" }] } }),
  );
  await page.route("**/api/quick-actions/followup-quick/accept", (route) => {
    accepted = true;
    return route.fulfill({ json: { opId: "followup-op", action: { ...action, status: "active" } } });
  });
  await page.route("**/api/quick-actions/undo", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ opId: "followup-op" });
    accepted = false;
    undone = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/more");
  await page.getByRole("button", { name: "Chief of staff", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Chief of staff" });
  const proposal = sheet.getByTestId("quick-action-proposal");
  await proposal.getByRole("button", { name: "Add", exact: true }).click();
  const notice = sheet.getByRole("status").filter({ hasText: "Added ·" });
  const undo = notice.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(() => undone).toBe(true);
  await expect(sheet).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(proposal).toBeVisible();
});
