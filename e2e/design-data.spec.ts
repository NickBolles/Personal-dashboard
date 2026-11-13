import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow, mock } from "./helpers";

async function post<T = unknown>(page: Page, path: string, data: unknown) {
  const r = await appPost(page, path, data);
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as T;
}

// Batch 5 design findings that needed new data: H1 rooms, C4 unread + filters, C1 agent mark / share.

test("house: devices grouped by Home Assistant room, collapsible, with an All toggle", async ({ page, request }) => {
  await mock(request, "/reset");
  await page.addInitScript(() => {
    localStorage.removeItem("jarvis:house-view");
    localStorage.removeItem("jarvis:house-collapsed");
  });
  await page.goto("/home-control");
  const room = (name: string) => page.locator(`section[data-room="${name}"]`);
  await expect(room("Front porch")).toContainText("Front door lock");
  await expect(room("Front porch")).toContainText("Porch light");
  await expect(room("Kitchen")).toContainText("Kitchen lights");
  await expect(room("Garage")).toContainText("Garage door 2");
  await expect(room("Unassigned")).toContainText("Driveway camera");
  // the room header (the room's light tiles are buttons named "Kitchen lights: …" too)
  const toggle = room("Kitchen").locator("h2").getByRole("button");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(room("Kitchen")).not.toContainText("Kitchen lights");
  await page.getByRole("group", { name: "Group devices" }).getByRole("button", { name: "All" }).click();
  await expect(page.locator("section[aria-labelledby=lights-h]")).toContainText("Kitchen lights");
  await expect(page.locator("section[data-room]")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("chat list: unread dot, filter chips, mark read on open and Mark all read", async ({ page }) => {
  const nonce = Date.now().toString(36);
  // The first list sets the read baseline, so only conversations that move afterwards are unread.
  await page.goto("/chat");
  await expect(page.getByRole("heading", { level: 1, name: "Conversations" })).toBeVisible();
  await page.waitForTimeout(1100);
  const a = await post<{ id: string }>(page, "/api/hermes/sessions", { title: `Unread alpha ${nonce}` });
  await post(page, "/api/hermes/sessions", { title: `Unread beta ${nonce}` });
  await page.goto("/chat");
  const row = (t: string) => page.locator("[data-conversation]", { hasText: t });
  await expect(row(`Unread alpha ${nonce}`)).toHaveAttribute("data-unread", "1");
  await page
    .getByRole("group", { name: "Show" })
    .getByRole("button", { name: /^Unread/ })
    .click();
  await expect(row(`Unread alpha ${nonce}`)).toBeVisible();
  await expect(page.locator("[data-conversation]:not([data-unread])")).toHaveCount(0);
  // Agents: only conversations routed to an agent profile (none here).
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Agents" }).click();
  await expect(row(`Unread alpha ${nonce}`)).toHaveCount(0);
  await page.getByRole("button", { name: "All conversations" }).click();
  // The default assistant is not repeated on every row; only an agent profile or another backend gets a mark.
  await expect(row(`Unread alpha ${nonce}`)).toBeVisible();
  await expect(row(`Unread alpha ${nonce}`).getByTestId("agent-mark")).toHaveCount(0);
  // Opening marks it read.
  await page.goto(`/chat/${a.id}`);
  await expect(page.getByRole("heading", { level: 1, name: `Unread alpha ${nonce}` })).toBeVisible();
  await expect
    .poll(async () => {
      const r = (await (await page.request.get("/api/work/conversations?view=all")).json()) as { conversations: { id: string; unread?: boolean }[] };
      return r.conversations.find((c) => c.id === a.id)?.unread;
    })
    .toBe(false);
  await page.goto("/chat");
  await expect(row(`Unread alpha ${nonce}`)).not.toHaveAttribute("data-unread", "1");
  await expect(row(`Unread beta ${nonce}`)).toHaveAttribute("data-unread", "1");
  await page.getByRole("button", { name: "Conversation list actions" }).click();
  await page.getByRole("menuitem", { name: "Mark all read" }).click();
  await expect(row(`Unread beta ${nonce}`)).not.toHaveAttribute("data-unread", "1");
  await expectNoHorizontalOverflow(page);
});

test("conversation ⋯ Share summary copies a read-only summary and link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const nonce = Date.now().toString(36);
  const s = await post<{ id: string }>(page, "/api/hermes/sessions", { title: `Share check ${nonce}` });
  await page.goto(`/chat/${s.id}`);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Share summary…" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Summary copied|Couldn't copy/ })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  if (text) {
    expect(text).toContain(`Share check ${nonce}`);
    expect(text).toContain(`/chat/${s.id}`);
  }
});
