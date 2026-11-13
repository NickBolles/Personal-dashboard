import { expect, test, type Page } from "@playwright/test";
import { appPost } from "./helpers";

/**
 * Work from Jarvis batch 2: agent runs on items (mock run states, the item page's Work list), the area
 * coordinator pane ("Catch me up" composes, nothing is sent until Send) and
 * #167 (Undo withdraws the pending conversation post). Titles use
 * Plover/Curlew/Dunlin/Whimbrel words no other spec uses.
 */

async function make(page: Page, body: Record<string, unknown>, patch?: Record<string, unknown>) {
  const r = await appPost(page, "/api/work/items", body);
  expect(r.ok(), await r.text()).toBeTruthy();
  const id = ((await r.json()) as { item: { id: string } }).item.id;
  if (patch) {
    const p = await page.request.patch(`/api/work/items/${id}`, { data: patch, headers: { "x-jarvis-csrf": "1" } });
    expect(p.ok(), await p.text()).toBeTruthy();
  }
  return id;
}

test("item Work list: a linked conversation's run is one row in the shared state words, and follows the runs", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const area = await make(page, { kind: "area", title: `Plover quay ${nonce}` });
  const id = await make(page, { kind: "thread", title: `Curlew relay ${nonce}`, parentId: area });
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  let live = "waiting";
  await page.route(/\/api\/work\/agent-runs(?:\?.*)?$/, (route) => {
    const info = {
      itemId: id,
      areaId: area,
      title: `Curlew relay ${nonce}`,
      who: { kind: "agent", name: "devchief" },
      live,
      ...(live === "waiting" ? { approval: true } : {}),
      liveAt: at,
      sessionId: "sess_morning",
      runs: 2,
      prs: [
        { ref: "o/r#41", url: "https://github.com/o/r/pull/41", title: `Curlew PR ${nonce}`, state: "open", checks: "failure", deploy: null },
        { ref: "o/r#40", url: "https://github.com/o/r/pull/40", title: "Curlew groundwork", state: "merged", checks: "success", deploy: "waiting" },
      ],
      report: { title: `Curlew findings ${nonce}`, summary: "Two of three relays answer.", at, href: null },
      progress: { done: 1, total: 3 },
    };
    return route.fulfill({ json: { items: { [id]: info }, active: live === "running" || live === "waiting" ? [info] : [] } });
  });
  await page.goto(`/areas?item=${id}`);
  // The six agent surfaces are one list now: Work. No registered run or job explains "waiting", so the linked
  // conversation is the row; it says who and what it waits for, and opens the conversation.
  const panel = page.getByTestId("item-agent-panel");
  await expect(panel).toBeVisible();
  const row = panel.getByTestId("agent-chat");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("agent-live")).toHaveText("Needs you");
  await expect(row).toContainText("approval");
  await expect(row).toContainText("@devchief");
  await expect(row.getByRole("link")).toHaveAttribute("href", "/chat/sess_morning");
  // What waits on the owner leads the page: the Next section points at the row instead of offering a primary action.
  const next = page.getByTestId("item-next");
  await expect(next.getByTestId("now-pointer")).toContainText("Needs you");
  await expect(next.getByRole("button", { name: "Start focused work" })).toHaveCount(0);
  // Pull requests are drawn once, as the item's own link rows in Plan (state, checks, live or not), and the last
  // report is a Done row from the item's AI reports: neither is repeated from the agent summary any more.
  await expect(panel.getByTestId("agent-pr")).toHaveCount(0);

  // The state follows the runs (polling/refetch): working, then failed. Never "Running" or "Waiting".
  live = "running";
  await page.reload();
  await expect(page.getByTestId("item-agent-panel").getByTestId("agent-live")).toHaveText("Working");
  await expect(page.getByTestId("item-next").getByRole("button", { name: "Start focused work" })).toBeVisible();
  live = "failed";
  await page.reload();
  await expect(page.getByTestId("item-agent-panel").getByTestId("agent-live")).toHaveText("Failed");
});

test("coordinator pane: Catch me up composes the prompt but sends nothing until Send; Undo withdraws the post offer (#167)", async ({ page }) => {
  test.setTimeout(90_000);
  const nonce = `c${Date.now().toString(36)}`;
  await page.goto("/home");
  const area = await make(page, { kind: "area", title: `Dunlin shoal ${nonce}` });
  const item = await make(
    page,
    { kind: "thread", title: `Whimbrel tide ${nonce}`, parentId: area },
    { decision: { question: `Whimbrel net ${nonce}?`, choices: ["Fine", "Coarse"] } },
  );
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/hermes\/sessions/.test(r.url())) sent.push(r.url());
  });

  await page.goto("/areas");
  const card = page.getByTestId("map-area-card").filter({ hasText: `Dunlin shoal ${nonce}` });
  await expect(card).toBeVisible();
  await page.getByRole("listitem").filter({ has: card }).getByTestId("coordinator-open").click();
  const pane = page.getByTestId("coordinator-pane");
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("heading", { name: `Dunlin shoal ${nonce} coordinator` })).toBeVisible();
  await expect(pane.getByTestId("coordinator-empty")).toBeVisible();

  await pane.getByTestId("coordinator-catch-up").click();
  const input = pane.getByTestId("coordinator-input");
  await expect(input).toHaveValue(new RegExp(`Catch me up on the "Dunlin shoal ${nonce}" area`));
  await expect(input).toHaveValue(new RegExp(`Whimbrel tide ${nonce}`));
  await expect(input).toHaveValue(new RegExp(`Whimbrel net ${nonce}\\?`));
  await page.waitForTimeout(800);
  expect(sent, "Catch me up must not send anything").toEqual([]);

  // Escape closes without sending; reopening starts empty.
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
  expect(sent).toEqual([]);

  await page.getByRole("listitem").filter({ has: card }).getByTestId("coordinator-open").click();
  // Enter adds a line and never sends; Send (or Ctrl/⌘ + Enter) does.
  const typed = pane.getByTestId("coordinator-input");
  await typed.fill(`Plover line ${nonce}`);
  await typed.press("Enter");
  await typed.pressSequentially("second line");
  await expect(typed).toHaveValue(`Plover line ${nonce}\nsecond line`);
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
  await pane.getByTestId("coordinator-catch-up").click();
  await pane.getByTestId("coordinator-send").click();
  await expect(page.getByText("Sent to the coordinator")).toBeVisible();
  await expect.poll(() => sent.some((u) => /\/runs$/.test(u))).toBe(true);
  await page.keyboard.press("Escape");

  // The new conversation is the area's coordinator chat: answering the item's decision offers to post there.
  await page.goto("/decisions");
  const row = page.getByTestId("decision-row").filter({ hasText: `Whimbrel net ${nonce}?` });
  await expect(row).toBeVisible();
  const before = sent.length;
  await row.getByRole("button", { name: /: Coarse$/ }).click();
  // The row becomes its receipt, which quietly offers to post the answer to the coordinator chat.
  const receipt = page.getByTestId("decision-receipt").filter({ hasText: `Whimbrel net ${nonce}?` });
  const offer = receipt.getByRole("button", { name: "Post to coordinator", exact: true });
  await expect(offer).toBeVisible();
  // #167: Undo withdraws the offer, nothing is posted.
  await receipt.getByRole("button", { name: /^Undo D-\d+$/ }).click();
  await expect(row).toBeVisible();
  await expect(offer).toBeHidden();
  expect(sent.length).toBe(before);

  const clear = await page.request.patch(`/api/work/items/${item}`, { data: { decision: null }, headers: { "x-jarvis-csrf": "1" } });
  expect(clear.ok()).toBeTruthy();
});
