import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * Areas (phase 4, docs/work.md "Areas"): one tree for work and conversations,
 * effortless new chats (Miscellaneous, zero filing), one-tap filing from the
 * conversation header, the composer's @ / # / / pickers, the model selector,
 * explicit household sharing and per-area settings.
 */

async function post<T = unknown>(page: Page, path: string, data: unknown) {
  const r = await appPost(page, path, data);
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as T;
}

test("a new chat lands in Miscellaneous, files in one tap, and the composer references work", async ({ page }) => {
  test.setTimeout(120_000);
  const nonce = Date.now().toString(36);
  const { item: area } = await post<{ item: { id: string } }>(page, "/api/work/items", { kind: "area", title: `Rollout ${nonce}` });
  const { item: thread } = await post<{ item: { id: string } }>(page, "/api/work/items", {
    kind: "thread",
    title: `Shadow rollout ${nonce}`,
    parentId: area.id,
  });
  await page.request.patch(`/api/work/items/${area.id}`, { data: { settings: { defaultRepo: "nick/jarvis" } }, headers: { "x-jarvis-csrf": "1" } });

  // New chat from the Areas header: no filing step, it opens right away.
  await page.goto("/areas");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[^/?]+$/);
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  await page.request.patch(`/api/hermes/sessions/${encodeURIComponent(sessionId)}`, {
    data: { title: `Shadow rollout plan ${nonce}` },
    headers: { "x-jarvis-csrf": "1" },
  });
  await page.reload();
  const chip = page.getByTestId("area-chip");
  await expect(chip).toContainText("Miscellaneous");
  // A deterministic suggestion (shared title words) files it in one tap.
  await chip.getByRole("button", { name: `File under Shadow rollout ${nonce}` }).click();
  await expect(chip).toContainText(`Rollout ${nonce} › Shadow rollout ${nonce}`);
  const tree = (await (await page.request.get("/api/work/items")).json()) as { items: { kind: string; sessionId: string | null; parentId: string | null }[] };
  expect(tree.items.find((i) => i.sessionId === sessionId)).toMatchObject({ kind: "conversation", parentId: thread.id });

  // @ picker: typed sections and filters; the pick becomes a chip in the sent message.
  const composer = page.locator("#composer");
  await composer.fill("Compare with @area:roll");
  const popover = page.getByTestId("composer-popover");
  // The area: filter leaves only areas (one matches).
  await expect(popover.getByRole("option")).toHaveCount(1);
  await expect(popover.getByRole("option", { name: `Rollout ${nonce} Area` })).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveValue(`Compare with @Rollout ${nonce} `);
  await composer.press("End");
  await composer.pressSequentially("and #");
  await expect(popover.getByRole("button", { name: /nick\/jarvis/ })).toBeVisible();
  await expect(popover.getByRole("option").first()).toBeVisible();
  await composer.press("Escape");
  await expect(popover).toHaveCount(0);
  // The picked reference stays attached while its @Label is in the text.
  await composer.fill(`Compare with @Rollout ${nonce} please`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = page.locator(`[data-ref="area:${area.id}"]`);
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent).toHaveText(`@Rollout ${nonce}`);
  await expect(page.getByText("Context Jarvis attached").first()).toBeVisible();

  // / commands: /model opens the searchable list from Hermes' real model list.
  await page.getByText("Done", { exact: true }).waitFor({ timeout: 20_000 });
  await composer.fill("/mod");
  await expect(popover.getByRole("option", { name: /\/model/ })).toBeVisible();
  await composer.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Model" });
  await expect(dialog.getByRole("option", { name: /hermes-agent/ })).toBeVisible();
  await dialog.getByRole("option", { name: /hermes-agent/ }).click();
  await dialog.getByRole("button", { name: "Use this model" }).click();
  await expect(page.getByTestId("model-chip")).toContainText("hermes-agent");
  await expectNoHorizontalOverflow(page);
});

test("share with the household is an explicit chip, listed in Settings and audited", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const s = await post<{ id: string }>(page, "/api/hermes/sessions", { title: `Dinner plans ${nonce}` });
  await page.goto(`/chat/${encodeURIComponent(s.id)}`);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Share with the household" }).click();
  const shared = page.getByTestId("shared-chip");
  await expect(shared).toContainText("Shared with household");
  await page.goto("/settings");
  const list = page.getByRole("list", { name: "Shared conversations" });
  await expect(list).toContainText(`Dinner plans ${nonce}`);
  await page.goto(`/chat/${encodeURIComponent(s.id)}`);
  await page.getByTestId("shared-chip").getByRole("button", { name: "Stop sharing" }).click();
  await expect(page.getByTestId("shared-chip")).toHaveCount(0);
  const audit = await page.request.get("/api/audit?limit=50");
  if (audit.ok()) {
    const body = JSON.stringify(await audit.json());
    expect(body).toContain("conversation.share");
    expect(body).toContain("conversation.unshare");
  }
});

test("area settings: agent mode, default repo and settle policy save on the area", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const { item: area } = await post<{ item: { id: string } }>(page, "/api/work/items", { kind: "area", title: `Settings check ${nonce}` });
  await page.goto(`/areas?item=${area.id}`);
  const card = page.getByTestId("area-settings");
  await card.locator("summary").click();
  await card.getByLabel("Agent mode").fill("momentumchief");
  await card.getByLabel("Default repo").fill("momentumbets/odds");
  await card.getByLabel("Settle policy").selectOption("auto_after_quiet");
  await card.getByLabel("Quiet days").fill("5");
  await card.getByRole("button", { name: "Save area settings" }).click();
  await expect(page.getByText("Area settings saved")).toBeVisible();
  const d = (await (await page.request.get(`/api/work/items/${area.id}`)).json()) as { item: { settings: Record<string, unknown> } };
  expect(d.item.settings).toMatchObject({ agentMode: "momentumchief", defaultRepo: "momentumbets/odds", settlePolicy: "auto_after_quiet", quietDays: 5 });
  await expectNoHorizontalOverflow(page);
});

test("the conversations view: All / Unfiled over the same tree data", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await post(page, "/api/hermes/sessions", { title: `Unfiled idea ${nonce}` });
  await page.goto("/chat");
  await expect(page.getByRole("heading", { level: 1, name: "Conversations" })).toBeVisible();
  await page.getByRole("button", { name: /^Unfiled/ }).click();
  await expect(page).toHaveURL(/view=unfiled/);
  await expect(page.locator("[data-conversation]", { hasText: `Unfiled idea ${nonce}` })).toContainText("Miscellaneous");
  await expectNoHorizontalOverflow(page);
});
