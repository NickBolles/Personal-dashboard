import { expect, test, type Request } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * PR A — one pinned Chief of staff thread. The coordinator rail (desktop 1280) and tray sheet (phone 412) show the
 * whole thread through "Load earlier" (no 6-message cap), open earlier threads in the panel (never /chat), start a new
 * thread only behind a confirm with Undo, draw a D-n decision a reply carries as the live decision block (F1) and
 * send a questionnaire form's answers as the owner's reply (F2). A smoke-style chat never becomes the thread.
 * The file name matches the desktop project's `global-coordinator.spec.ts` pattern. Words ("Bramble", "Loosestrife")
 * are unique to this spec.
 */

import { stubCoordinator, openChat } from "./fixtures/decision-batch";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
function longThread(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: i % 2 ? ("assistant" as const) : ("user" as const),
    id: `m${i + 1}`,
    text: `Bramble message ${i + 1}`,
    at: iso(300 - i),
  }));
}

test("pinned thread: whole conversation via Load earlier, earlier threads open in the panel, New thread asks and undoes", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const state = await stubCoordinator(
    page,
    { "cw-pin": longThread(30), "cw-old": [{ kind: "user", id: "o1", text: "Loosestrife plan from last week", at: iso(9000) }] },
    { current: "cw-pin" },
  );
  await page.goto("/more");
  const scope = await openChat(page, desktop);
  const list = scope.getByRole("list", { name: "Latest messages" });
  await expect(list.getByText("Bramble message 30", { exact: true })).toBeVisible();
  // More than 6 turns are on screen, and the rest is one "Load earlier" away, in the panel.
  await expect(list.getByText("Bramble message 20", { exact: true })).toBeVisible();
  await expect(list.getByText("Bramble message 1", { exact: true })).toHaveCount(0);
  await scope.getByTestId("gc-load-earlier").click();
  await expect(list.getByText("Bramble message 1", { exact: true })).toBeVisible();
  await expect(scope.getByTestId("gc-load-earlier")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/more");

  // Earlier threads open here; smoke chats are never offered.
  await scope.getByText("Earlier threads", { exact: true }).click();
  const earlier = scope.getByRole("list", { name: "Earlier threads" });
  await expect(earlier.getByRole("button", { name: "Older bramble thread" })).toBeVisible();
  await expect(earlier.getByText(/zz-smoke/)).toHaveCount(0);
  await earlier.getByRole("button", { name: "Older bramble thread" }).click();
  await expect(scope.getByText("Loosestrife plan from last week")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/more");
  const banner = scope.getByRole("group", { name: "Earlier thread" });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Back to current" }).click();
  await expect(list.getByText("Bramble message 30", { exact: true })).toBeVisible();

  // New thread asks first; Undo brings the thread back. Nothing is created or pinned until a message is sent.
  await scope.getByRole("button", { name: "New thread", exact: true }).click();
  const confirm = scope.getByRole("group", { name: "Start a new thread?" });
  await confirm.getByRole("button", { name: "Start new thread" }).click();
  await expect(scope.getByRole("status").filter({ hasText: "New thread: your next message starts it." })).toBeVisible();
  await expect(list).toHaveCount(0);
  await scope.getByRole("status").filter({ hasText: "New thread" }).getByRole("button", { name: "Undo" }).click();
  await expect(scope.getByRole("list", { name: "Latest messages" }).getByText("Bramble message 30", { exact: true })).toBeVisible();
  expect(state.pins).toEqual([]);

  // "Use this thread" pins an earlier thread. (The Earlier threads list is still open from before.)
  if (!(await scope.getByRole("list", { name: "Earlier threads" }).isVisible())) await scope.getByText("Earlier threads", { exact: true }).click();
  await scope.getByRole("list", { name: "Earlier threads" }).getByRole("button", { name: "Older bramble thread" }).click();
  await scope.getByRole("group", { name: "Earlier thread" }).getByRole("button", { name: "Use this thread" }).click();
  // The pin change asks first.
  expect(state.pins).toEqual([]);
  await scope.getByRole("group", { name: "Make this the Chief of staff thread?" }).getByRole("button", { name: "Use this thread" }).click();
  await expect.poll(() => state.pins).toEqual(["cw-old"]);
  await expect(scope.getByRole("group", { name: "Earlier thread" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("questionnaire form in a coordinator reply: Submit sends the answers as the owner's reply (F2)", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const form = {
    v: 1,
    catalog: "jarvis-ui@1",
    root: "r",
    elements: {
      r: {
        type: "Form",
        props: {
          title: "Bramble check-in",
          fields: [
            { id: "today", label: "How did the bramble day go?", kind: "textarea", required: true },
            {
              id: "energy",
              label: "Bramble energy",
              kind: "choice",
              options: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
          ],
          submit: { label: "Submit check-in" },
        },
      },
    },
  };
  const state = await stubCoordinator(
    page,
    { "cw-pin": [{ kind: "assistant", id: "f1", text: `A quick check-in.\n\n\`\`\`jarvis-ui\n${JSON.stringify(form)}\n\`\`\``, at: iso(5) }] },
    { current: "cw-pin" },
  );
  await page.route("**/api/smart/settings", (route) => route.fulfill({ json: { enabled: true, calendarWrites: false } }));
  const surface = { id: "sf-bramble", specHash: "x", state: {} as Record<string, unknown>, applied: [], readOnly: false };
  await page.route("**/api/smart/surfaces**", (route) => {
    if (route.request().method() === "PATCH") surface.state = (route.request().postDataJSON() as { state: Record<string, unknown> }).state;
    return route.fulfill({ json: surface });
  });
  await page.goto("/more");
  const scope = await openChat(page, desktop);
  const card = scope.getByTestId("answer-batch");
  await card.getByRole("textbox", { name: /How did the bramble day go/ }).fill("Pruned the bramble hedge");
  await card.getByRole("button", { name: "High", exact: true }).click();
  expect(state.runs).toHaveLength(0);
  const sent = page.waitForRequest((r: Request) => r.method() === "POST" && /\/api\/hermes\/sessions\/cw-pin\/runs$/.test(new URL(r.url()).pathname));
  await card.getByRole("button", { name: "Submit choices" }).click();
  await card.getByRole("button", { name: "Confirm send reply" }).click();
  const body = (await sent).postDataJSON() as { input: string };
  expect(body.input).toContain("Bramble check-in");
  expect(body.input).toContain("Pruned the bramble hedge");
  expect(body.input).toContain("High [choice:high]");
  await expect(card.getByRole("status")).toHaveText("Sent as one reply to this conversation.");
  expect(state.runs).toHaveLength(1);
  await expect(scope.getByTestId("smart-tray-count")).toHaveCount(0);
});

type Minted = { token: string; view: { id: string } };
let areaId: string | null = null;
let minted: Minted | null = null;
test.afterEach(async ({ page }) => {
  if (minted) await page.request.delete(`/api/settings/agents/tokens/${minted.view.id}`, { headers: { "x-jarvis-csrf": "1" } });
  if (areaId) await page.request.patch(`/api/work/items/${areaId}`, { data: { archived: true }, headers: { "x-jarvis-csrf": "1" } });
  minted = null;
  areaId = null;
});

test("a D-n decision card replies conversationally without answering the owner decision", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const nonce = `${Date.now().toString(36)}${info.retry}${info.project.name.replace(/\W/g, "")}`;
  await page.goto("/home");
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Bramble bench ${nonce}` });
  areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const it = await appPost(page, "/api/work/items", { kind: "thread", title: `Bramble ledger ${nonce}`, parentId: areaId });
  const itemId = ((await it.json()) as { item: { id: string } }).item.id;
  const m = await appPost(page, "/api/settings/agents/tokens", {
    name: `Bramble ${nonce}`,
    profile: `br${nonce}`.slice(0, 30),
    scopes: ["work.read", "decisions.write"],
  });
  expect(m.ok(), await m.text()).toBeTruthy();
  minted = (await m.json()) as Minted;
  const raised = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "jarvis_raise_decision",
        arguments: { itemId, question: `Ship the bramble ledger ${nonce}?`, choices: ["Ship it", "Wait"], recommended: "Ship it" },
      },
    },
  });
  const ref = ((await raised.json()) as { result: { structuredContent: { ref: string } } }).result.structuredContent.ref;
  expect(ref).toMatch(/^D-\d+$/);
  // The reply draws the decision as a smart card whose options carry no intents (what the agent wrote for D-33).
  const card = {
    v: 1,
    catalog: "jarvis-ui@1",
    root: "r",
    elements: {
      r: {
        type: "DecisionCard",
        props: {
          title: `${ref} · Ship the bramble ledger`,
          options: [
            { id: "ship", label: "Ship it", recommended: true },
            { id: "wait", label: "Wait" },
          ],
        },
      },
    },
  };
  await stubCoordinator(
    page,
    { "cw-pin": [{ kind: "assistant", id: "d1", text: `${ref} is about the ledger.\n\n\`\`\`jarvis-ui\n${JSON.stringify(card)}\n\`\`\``, at: iso(5) }] },
    { current: "cw-pin", stubDecisions: false },
  );
  await page.route("**/api/smart/settings", (route) => route.fulfill({ json: { enabled: true, calendarWrites: false } }));
  await page.goto("/more");
  const scope = await openChat(page, desktop);
  const batch = scope.getByTestId("answer-batch");
  await expect(batch).toBeVisible();
  await batch.getByRole("button", { name: /Ship it/ }).click();
  await batch.getByRole("button", { name: "Submit choices" }).click();
  await batch.getByRole("button", { name: "Confirm send reply" }).click();
  await expect(batch.getByRole("status")).toHaveText("Sent as one reply to this conversation.");
  const res = await page.request.get("/api/coordinator/decisions?state=all");
  expect(((await res.json()) as { decisions: { ref: string; state: string }[] }).decisions.find((d) => d.ref === ref)?.state).toBe("open");
  await expectNoHorizontalOverflow(page);
});

test("a smoke-style chat filed under the area never becomes its coordinator thread; a pin holds", async ({ page }, info) => {
  const nonce = `${Date.now().toString(36)}${info.retry}${info.project.name.replace(/\W/g, "")}`;
  await page.goto("/home");
  const a = await appPost(page, "/api/work/items", { kind: "area", title: `Loosestrife desk ${nonce}` });
  areaId = ((await a.json()) as { item: { id: string } }).item.id;
  const chat = async (title: string) => {
    const r = await appPost(page, "/api/hermes/sessions", { title, areaId });
    expect(r.ok(), await r.text()).toBeTruthy();
    return ((await r.json()) as { id: string }).id;
  };
  const coord = async () => (await (await page.request.get(`/api/work/items/${areaId}/coordinator`)).json()) as { sessionId: string | null; pinned: boolean };
  const owner = await chat(`Loosestrife owner ${nonce}`);
  await expect.poll(async () => (await coord()).sessionId).toBe(owner);
  await chat(`zz-smoke 15:42 loosestrife ${nonce}`);
  expect(await coord()).toMatchObject({ sessionId: owner, pinned: false });
  const put = await page.request.put(`/api/work/items/${areaId}/coordinator`, {
    data: { sessionId: owner },
    headers: { "x-jarvis-csrf": "1", "content-type": "application/json" },
  });
  expect(put.ok(), await put.text()).toBeTruthy();
  await chat(`Loosestrife later ${nonce}`);
  expect(await coord()).toMatchObject({ sessionId: owner, pinned: true });
});
