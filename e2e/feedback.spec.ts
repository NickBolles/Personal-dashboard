import { expect, test } from "@playwright/test";
import { appPost, mock, revealMessageMeta, startConversation } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("rate a reply 👎 with a reason, then Ask to fix sends a follow-up in the same chat", async ({ page }) => {
  await startConversation(page, "tell me about quokkas please");
  await expect(page.locator('[data-testid="msg-bubble"][data-who="assistant"]').first()).toContainText("quokkas", { timeout: 20_000 });
  const url = page.url();
  const meta = await revealMessageMeta(page, "assistant");
  await meta.getByRole("button", { name: /^Bad response/ }).click();
  const dialog = page.getByRole("dialog", { name: "What went wrong?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Wrong", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Wrong", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Note (optional)").fill("Quokkas live on Rottnest Island");
  await dialog.getByRole("button", { name: "Ask to fix…" }).click();
  const fix = page.getByRole("dialog", { name: "Ask to fix" });
  const text = fix.getByLabel("Message to send");
  await expect(text).toHaveValue(/👎 Wrong/);
  await expect(text).toHaveValue(/What went wrong: Quokkas live on Rottnest Island/);
  await fix.getByRole("button", { name: "Send", exact: true }).click();
  await expect(fix).toBeHidden();
  // The follow-up lands in the same conversation and the agent answers it.
  expect(page.url()).toBe(url);
  await expect(page.locator('[data-testid="msg-bubble"][data-who="user"]').filter({ hasText: "Feedback on your previous reply" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="msg-bubble"][data-who="assistant"]').filter({ hasText: "Feedback on your previous" })).toBeVisible({
    timeout: 20_000,
  });
  // The first reply shows as rated.
  const meta2 = await revealMessageMeta(page, "assistant");
  await expect(meta2.getByRole("button", { name: /^Rated bad/ })).toHaveAttribute("aria-pressed", "true");
  // And the inbox has it, with the fix asked.
  await page.goto("/feedback");
  const row = page.getByTestId("feedback-row").filter({ hasText: "Rottnest" });
  await expect(row).toContainText("Wrong");
  await expect(row).toContainText("Fix asked");
  await expect(row).toContainText("New");
  const id = (await (await page.request.get("/api/feedback?rating=down")).json()).entries.find((e: { note: string }) => e.note.includes("Rottnest")).id;
  await page.request.delete(`/api/feedback/${id}`, { headers: { "x-jarvis-csrf": "1" } });
});

test("👍 saves in one tap with Undo", async ({ page }) => {
  await startConversation(page, "tell me about wombats please");
  await expect(page.locator('[data-testid="msg-bubble"][data-who="assistant"]').first()).toContainText("wombats", { timeout: 20_000 });
  const meta = await revealMessageMeta(page, "assistant");
  await meta.getByRole("button", { name: /^Good response/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rated good" })).toBeVisible();
  await expect(meta.getByRole("button", { name: /^Rated good/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("status").filter({ hasText: "Rated good" }).getByRole("button", { name: "Undo" }).click();
  await expect(meta.getByRole("button", { name: /^Good response/ })).toHaveAttribute("aria-pressed", "false");
});

test("feedback inbox: filter by reason, mark triaged with Undo, create an item with Undo", async ({ page }) => {
  await page.goto("/feedback");
  const seed = async (messageId: string, body: Record<string, unknown>) => {
    const r = await appPost(page, "/api/feedback", { sessionId: "sess_morning", messageId, surface: "chat", text: "Seeded numbat reply", ...body });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { feedback: { id: string } }).feedback.id;
  };
  const slow = await seed("fb-e2e-numbat-1", { rating: "down", reasons: ["slow"], note: "Numbat answer took ages" });
  const wrong = await seed("fb-e2e-numbat-2", { rating: "down", reasons: ["wrong"], note: "Numbat facts wrong" });
  const up = await seed("fb-e2e-numbat-3", { rating: "up" });
  try {
    await page.reload();
    const list = page.getByTestId("feedback-list");
    await expect(list.getByTestId("feedback-row").filter({ hasText: "Numbat" })).toHaveCount(2);
    await page.getByLabel("Reason").selectOption("slow");
    await expect(list.getByTestId("feedback-row").filter({ hasText: "Numbat" })).toHaveCount(1);
    const row = list.getByTestId("feedback-row").filter({ hasText: "Numbat answer took ages" });
    await row.getByRole("button", { name: /^More for feedback/ }).click();
    await page.getByRole("menuitem", { name: "Mark triaged" }).click();
    await expect(row).toContainText("Triaged");
    await page.getByRole("status").filter({ hasText: "Marked triaged" }).getByRole("button", { name: "Undo" }).click();
    await expect(row).toContainText("New");
    await row.getByRole("button", { name: /^More for feedback/ }).click();
    await page.getByRole("menuitem", { name: "Create item…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create item" }).click();
    await expect(row.getByRole("link", { name: /^Item: Feedback: Slow/ })).toBeVisible();
    await expect(row).toContainText("Triaged");
    await page.getByRole("status").filter({ hasText: "Item created" }).getByRole("button", { name: "Undo" }).click();
    await expect(row.getByRole("link", { name: /^Item:/ })).toHaveCount(0);
  } finally {
    for (const id of [slow, wrong, up]) await page.request.delete(`/api/feedback/${id}`, { headers: { "x-jarvis-csrf": "1" } });
  }
});
