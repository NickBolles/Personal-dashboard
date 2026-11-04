import { expect, test, type Page } from "@playwright/test";
import { appPost, mock, startConversation } from "./helpers";

/**
 * Coordinator chat PR 1: adopt an existing Hermes chat (one Jarvis didn't start) into an area,
 * Hermes control frames as compact cards (async delegation, background process, compaction), and
 * clarify questions answered with one tap. All against the mock Hermes (never a real profile).
 * The mock seeds `sess_mc_notices` (normal chat), `sess_mc_botchat` (hidden Bot Chat) and a
 * sub-agent child on the momentumchief profile.
 */

async function putAgents(page: Page, body: unknown) {
  const r = await page.request.put("/api/settings/agents", { data: body, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

const ROUTE = { profile: "momentumchief", keyEnv: "JARVIS_HERMES_KEY_MOMENTUMCHIEF", baseUrl: null };

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});
test.afterEach(async ({ page }) => {
  await putAgents(page, { routing: false, aguiStream: false, routes: [] });
});

test("adopt an existing chat into an area; its notices render as cards", async ({ page }) => {
  await putAgents(page, { routing: false, aguiStream: false, routes: [ROUTE] });
  const r = await appPost(page, "/api/work/items", { kind: "area", title: "Lighthouse vendors" });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { item } = (await r.json()) as { item: { id: string } };
  const p = await page.request.patch(`/api/work/items/${item.id}`, { data: { settings: { agentMode: "momentumchief" } }, headers: { "x-jarvis-csrf": "1" } });
  expect(p.ok()).toBeTruthy();

  // The Bot Chat inbox is refused server-side even when asked for by id.
  const bot = await appPost(page, "/api/hermes/sessions/adopt", { profile: "momentumchief", sessionId: "sess_mc_botchat" });
  expect(bot.status()).toBe(409);
  expect(await bot.text()).toContain("Bot Chat");

  // Whether an earlier project/attempt already adopted the seeded chat (then it isn't offered any more).
  const adoptable = await page.request.get("/api/hermes/sessions/adoptable?profile=momentumchief");
  expect(adoptable.ok(), await adoptable.text()).toBeTruthy();
  const fresh = ((await adoptable.json()) as { sessions: { id: string }[] }).sessions.some((s) => s.id === "sess_mc_notices");

  await page.goto(`/areas?item=${item.id}`);
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Adopt existing chat…" }).click();
  const dialog = page.getByRole("dialog", { name: "Adopt an existing chat" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Agent")).toHaveValue("momentumchief");
  const list = dialog.getByRole("list", { name: "Chats to adopt" });
  // Never offered: the Bot Chat inbox and sub-agent working sessions.
  await expect(list.getByText("Bot Chat")).toHaveCount(0);
  await expect(list.getByText(/Subagent:/)).toHaveCount(0);
  if (fresh) {
    await expect(list.getByRole("button", { name: /Quarterly vendor review/ })).toBeVisible();
    await list.getByRole("button", { name: /Quarterly vendor review/ }).click();
  } else {
    // Another project/attempt already adopted it (shared server DB, adoption isn't undone by the mock reset):
    // it's no longer listed, so take the paste-an-id path (adopting a chat already tracked on the same agent is idempotent).
    await expect(list.getByRole("button", { name: /Quarterly vendor review/ })).toHaveCount(0);
    await dialog.getByLabel("Or paste a session id").fill("sess_mc_notices");
    await dialog.getByRole("button", { name: "Next" }).click();
  }

  const confirm = page.getByRole("dialog", { name: "Adopt this chat?" });
  await expect(confirm).toContainText("momentumchief");
  await confirm.getByRole("button", { name: "Adopt and file" }).click();
  await expect(confirm).toBeHidden();

  // Opened from Jarvis, on the profile it lives on.
  await page.goto("/chat/sess_mc_notices");
  const notice = page.getByTestId("chat-notice").filter({ hasText: "2 subagents finished" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("partial");
  await expect(notice).toContainText("241.5s");
  // Collapsed by default: no task rows until opened.
  await expect(page.getByTestId("notice-task").first()).toBeHidden();
  await notice.locator("summary").first().click();
  const task = notice.getByTestId("notice-task").filter({ hasText: "Price the Acme quote" });
  await expect(task).toBeVisible();
  await task.locator("summary").click();
  await expect(task).toContainText("Acme comes to $4,200/yr");
  // The transcript is a host path to copy, never a link.
  await expect(task.getByTestId("transcript-path")).toHaveText("/opt/data/transcripts/deleg_e2e1-task1.jsonl");
  await expect(task.locator("a")).toHaveCount(0);
  await expect(page.getByTestId("chat-notice").filter({ hasText: "Background process finished" })).toBeVisible();

  // Compaction is a thin divider with the summary one tap away.
  const divider = page.getByTestId("chat-compaction");
  await expect(divider).toContainText("Earlier conversation summarized");
  await divider.getByText("Earlier conversation summarized").click();
  await expect(divider).toContainText("quotes from Acme, Birch and Cobalt");
  // None of it renders as something the person typed.
  await expect(page.locator('[data-who="user"]').filter({ hasText: "ASYNC DELEGATION" })).toHaveCount(0);
});

test("clarify question: one tap answers it", async ({ page }) => {
  await startConversation(page, "Please clarify the accent before you start");
  const card = page.getByTestId("clarify-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Which colour should the dashboard accent be?");
  const sent = page.waitForRequest((r) => /\/api\/hermes\/runs\/[^/]+\/clarify$/.test(r.url()) && r.method() === "POST");
  await card.getByRole("button", { name: "Amber" }).click();
  const req = await sent;
  expect(Object.keys(req.postDataJSON() as object).sort()).toEqual(["answer", "requestId"]);
  await expect(card).toBeHidden();
  await expect(page.getByText("Going with Amber.")).toBeVisible();
});
