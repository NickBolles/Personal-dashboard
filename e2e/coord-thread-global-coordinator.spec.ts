import { expect, test, type Page, type Request } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * PR A — one pinned Chief of staff thread. The coordinator rail (desktop 1280) and tray sheet (phone 412) show the
 * whole thread through "Load earlier" (no 6-message cap), open earlier threads in the panel (never /chat), start a new
 * thread only behind a confirm with Undo, draw a D-n decision a reply carries as the live decision block (F1) and
 * send a questionnaire form's answers as the owner's reply (F2). A smoke-style chat never becomes the thread.
 * The file name matches the desktop project's `global-coordinator.spec.ts` pattern. Words ("Bramble", "Loosestrife")
 * are unique to this spec.
 */

type Msg = { kind: "user" | "assistant"; id: string; text: string; at: string };
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

function longThread(n: number): Msg[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: i % 2 ? "assistant" : "user",
    id: `m${i + 1}`,
    text: `Bramble message ${i + 1}`,
    at: iso(300 - i),
  }));
}

/** Fully stubbed coordinator: `threads` by session id; the pin is stateful (PUT changes what the global info says). */
async function stubCoordinator(page: Page, threads: Record<string, Msg[]>, opts: { current: string; stubDecisions?: boolean }) {
  const state = { current: opts.current, pins: [] as (string | null)[], runs: [] as { sid: string; body: Record<string, unknown> }[] };
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: state.current,
        sessionTitle: state.current === "cw-pin" ? "Chief of staff" : "Older bramble thread",
        pinned: true,
        excluded: false,
        prompt: "Catch me up",
        lastRunAt: null,
      },
    }),
  );
  await page.route("**/api/work/items/portfolio/coordinator", (route) => {
    const body = route.request().postDataJSON() as { sessionId: string | null };
    const previous = state.current;
    state.pins.push(body.sessionId);
    if (body.sessionId) state.current = body.sessionId;
    return route.fulfill({ json: { areaId: "portfolio", sessionId: state.current, pinned: true, previous } });
  });
  await page.route("**/api/work/conversations*", (route) =>
    route.fulfill({
      json: {
        conversations: [
          { id: "cw-old", title: "Older bramble thread", placement: { parentId: "portfolio" }, suggestions: [] },
          { id: "zz-bramble", title: "zz-smoke 15:42 api_bramble", placement: { parentId: "portfolio" }, suggestions: [] },
        ],
        unfiledCount: 0,
        unreadCount: 0,
        unavailable: [],
      },
    }),
  );
  await page.route("**/api/work/decisions*", (route) => route.fulfill({ json: { entries: [], count: 0 } }));
  await page.route("**/api/work/agent-runs*", (route) => route.fulfill({ json: { items: {}, active: [] } }));
  await page.route("**/api/work/activity**", (route) => route.fulfill({ json: { items: [], nextCursor: null, latestAt: null } }));
  await page.route("**/api/work/items*", (route) => route.fulfill({ json: { items: [], linkedConversations: [] } }));
  if (opts.stubDecisions !== false)
    await page.route("**/api/coordinator/decisions*", (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route("**/api/coordinator/runs", (route) =>
    route.fulfill({ json: { runs: [], events: [], lastLooked: { chat: new Date().toISOString(), needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/coordinator/looked", (route) =>
    route.fulfill({ json: { lastLooked: { chat: new Date().toISOString(), needs: null, running: null, changes: null, context: null } } }),
  );
  await page.route("**/api/hermes/sessions**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const sid = decodeURIComponent(path.split("/")[4] ?? "");
    if (req.method() === "POST" && path.endsWith("/runs")) {
      state.runs.push({ sid, body: req.postDataJSON() as Record<string, unknown> });
      return route.fulfill({ json: { runId: `run-${state.runs.length}`, sessionId: sid, status: "completed" } });
    }
    if (req.method() !== "GET") return route.fulfill({ status: 409, json: { error: "Not part of this test" } });
    if (path.endsWith("/area")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/execution"))
      return route.fulfill({ json: { sessionId: sid, parent: null, records: [], sources: [{ source: "transcript", state: "ok" }], fetchedAt: iso(0) } });
    if (path.endsWith("/files") || path.endsWith("/links-panel")) return route.fulfill({ json: { files: [], links: [] } });
    if (path === "/api/hermes/sessions") return route.fulfill({ json: { sessions: [], nextOffset: null } });
    const title = sid === "cw-pin" ? "Chief of staff" : "Older bramble thread";
    return route.fulfill({ json: { session: { id: sid, title, pinned: false, archived: false }, children: [], links: [], timeline: threads[sid] ?? [] } });
  });
  return state;
}

/** Opens the Chief of staff Chat tab: the tray sheet on phones, the rail on desktop. */
async function openChat(page: Page, desktop: boolean) {
  const scope = desktop ? page.getByRole("complementary", { name: "Chief of staff" }) : page.getByRole("dialog", { name: "Chief of staff" });
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await scope.getByRole("tab", { name: "Chat", exact: true }).click();
  return scope;
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
  const card = scope.getByRole("region", { name: "Bramble check-in" });
  await card.getByLabel(/How did the bramble day go/).fill("Pruned the bramble hedge");
  await card.getByLabel("Bramble energy").selectOption("high");
  const sent = page.waitForRequest((r: Request) => r.method() === "POST" && /\/api\/hermes\/sessions\/cw-pin\/runs$/.test(new URL(r.url()).pathname));
  await card.getByRole("button", { name: "Submit check-in" }).click();
  const body = (await sent).postDataJSON() as { input: string };
  expect(body.input).toContain("**Bramble check-in**");
  expect(body.input).toContain("Pruned the bramble hedge");
  expect(body.input).toContain("High");
  await expect(card.getByRole("status")).toHaveText("Sent to the chat as your reply.");
  await expect(card.getByRole("button", { name: "Submit check-in" })).toBeDisabled();
  expect(state.runs).toHaveLength(1);
  // A questionnaire stages nothing: no change tray.
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

test("a D-n decision a coordinator reply draws is the live decision block: answered in place (F1)", async ({ page }, info) => {
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
  await page.goto("/more");
  const scope = await openChat(page, desktop);
  const live = scope.getByTestId("smart-live-decision");
  await expect(live).toBeVisible();
  // Drawn once: the live block replaces the card, and the prose mention adds no second row.
  await expect(scope.locator(`[data-ref-row="${ref}"]`)).toHaveCount(1);
  await expect(scope.getByRole("radio", { name: /Ship it/ })).toHaveCount(0);
  await live.getByRole("button", { name: `${ref}: Ship it (recommended)`, exact: true }).click();
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/coordinator/decisions?state=all");
      return ((await res.json()) as { decisions: { ref: string; state: string }[] }).decisions.find((d) => d.ref === ref)?.state;
    })
    .toBe("answered");
  await expect(scope.getByRole("button", { name: `Undo ${ref}`, exact: true }).first()).toBeVisible();
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
