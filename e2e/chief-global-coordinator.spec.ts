import { expect, test, type Page } from "@playwright/test";
import { appPost, expectNoHorizontalOverflow } from "./helpers";

/**
 * Expand: /chief is the Chief of staff conversation as the page. It is the shell's one panel at full size (not a
 * second copy), so the draft and the place in the thread carry over; wide screens show the conversation beside
 * Needs you / Activity; and the pinned thread's own chat address leads here.
 * The file name matches the desktop project's `global-coordinator.spec.ts` pattern. "Whitebeam" is unique to this spec.
 */

type Msg = { kind: "user" | "assistant"; id: string; text: string; at: string };
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const thread: Msg[] = Array.from({ length: 24 }, (_, i) => ({
  kind: i % 2 ? "assistant" : "user",
  id: `w${i + 1}`,
  text: `Whitebeam message ${i + 1}: enough words to take more than one line in a narrow column`,
  at: iso(200 - i),
}));

async function stubCoordinator(page: Page) {
  const looked = () => ({ chat: new Date().toISOString(), needs: null, running: null, changes: null, context: null });
  await page.route("**/api/work/coordinator/global", (route) =>
    route.fulfill({
      json: {
        area: { id: "portfolio", title: "Portfolio" },
        scope: "global",
        agent: { requested: "chiefofstaff", profile: "chiefofstaff", routed: true, reason: "routed" },
        sessionId: "wb-pin",
        sessionTitle: "Chief of staff",
        pinned: true,
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
  await page.route("**/api/coordinator/decisions*", (route) => route.fulfill({ json: { decisions: [], counts: { open: 0, deferred: 0 } } }));
  await page.route("**/api/coordinator/runs", (route) => route.fulfill({ json: { runs: [], events: [], lastLooked: looked() } }));
  await page.route("**/api/coordinator/looked", (route) => route.fulfill({ json: { lastLooked: looked() } }));
  await page.route("**/api/agents/away", (route) =>
    route.fulfill({ json: { runs: [], since: null, line: null, counts: { ran: 0, failed: 0, changes: 0, needsYou: 0, running: 0, waiting: 0 } } }),
  );
  await page.route("**/api/hermes/sessions**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const sid = decodeURIComponent(path.split("/")[4] ?? "");
    if (req.method() !== "GET") return route.fulfill({ status: 409, json: { error: "Not part of this test" } });
    if (path.endsWith("/area")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/execution"))
      return route.fulfill({ json: { sessionId: sid, parent: null, records: [], sources: [{ source: "transcript", state: "ok" }], fetchedAt: iso(0) } });
    if (path.endsWith("/files") || path.endsWith("/links-panel")) return route.fulfill({ json: { files: [], links: [] } });
    if (path === "/api/hermes/sessions") return route.fulfill({ json: { sessions: [], nextOffset: null } });
    return route.fulfill({
      json: { session: { id: sid, title: "Chief of staff", pinned: false, archived: false }, children: [], links: [], timeline: thread },
    });
  });
}

test("Expand: the same thread at full size keeps the draft and the place; wide screens add a side column", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await stubCoordinator(page);
  await page.goto("/more");
  const panel = () => (desktop ? page.getByRole("complementary", { name: "Chief of staff" }) : page.getByRole("dialog", { name: "Chief of staff" }));
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await panel().getByRole("tab", { name: "Chat", exact: true }).click();
  const input = panel().getByTestId("gc-input");
  await input.fill("Whitebeam draft, half written");
  await expect(panel().getByText(/^Whitebeam message 24/)).toBeVisible();
  // The way to the whole conversation is Expand: there is no link out to a different-looking copy.
  await expect(panel().getByRole("link", { name: "Open full conversation" })).toHaveCount(0);

  // Scroll up to read something older, then expand.
  const body = panel().getByTestId("gc-thread-body");
  await body.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 300);
  });
  const reading = await body.evaluate((el) => el.scrollTop);
  expect(reading).toBeGreaterThan(0);
  await panel().getByRole("button", { name: "Expand Chief of staff" }).click();
  await expect(page).toHaveURL(/\/chief$/);

  // Same panel, same words in the composer, same place in the thread.
  await expect(panel()).toHaveAttribute("data-full", "true");
  await expect(panel().getByTestId("gc-input")).toHaveValue("Whitebeam draft, half written");
  if (!desktop)
    expect(
      await panel()
        .getByTestId("gc-thread-body")
        .evaluate((el) => el.scrollTop),
    ).toBe(reading);
  await expect(panel().getByText(/^Whitebeam message 24/)).toBeAttached();
  await expect(panel().getByText(/^Viewing:/)).toHaveCount(0);

  const box = (await panel().boundingBox())!;
  const viewport = page.viewportSize()!;
  if (desktop) {
    // The conversation and the side column are on screen together; the tabs choose the side column only.
    await expect(panel().getByRole("tab")).toHaveText([/^Needs you/, /^Activity/]);
    await expect(panel().getByRole("region", { name: "Conversation" })).toBeVisible();
    await panel()
      .getByRole("tab", { name: /^Activity/ })
      .click();
    await expect(panel().getByRole("tabpanel", { name: /^Activity/ })).toBeVisible();
    await expect(panel().getByTestId("gc-input")).toBeVisible();
    // It takes the page's place beside the sidebar: much wider than a rail, flush with the right edge.
    expect(box.width).toBeGreaterThan(viewport.width * 0.6);
    expect(Math.round(box.x + box.width)).toBe(viewport.width);
  } else {
    // Below the split width the sheet covers the screen and keeps its tabs.
    await expect(panel().getByRole("tab")).toHaveText([/^Chat/, /^Needs you/, /^Activity/]);
    expect(Math.round(box.height)).toBe(viewport.height);
    expect(Math.round(box.y)).toBe(0);
  }
  await expectNoHorizontalOverflow(page);

  // Leaving goes back to the page the owner came from, with the draft still there.
  await panel().getByRole("button", { name: "Leave full view" }).click();
  await expect(page).toHaveURL(/\/more$/);
  if (!desktop) await page.locator(".gc-tray").getByRole("button", { name: "Chief of staff", exact: true }).click();
  await expect(panel().getByTestId("gc-input")).toHaveValue("Whitebeam draft, half written");
});

test("the pinned Chief of staff thread's chat address leads to /chief; another conversation keeps its own", async ({ page }, info) => {
  const headers = { "x-jarvis-csrf": "1" };
  const readGlobal = async () => {
    const res = await page.request.get("/api/work/coordinator/global");
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()) as { area: { id: string } | null; sessionId?: string | null; pinned?: boolean };
  };
  // A database with no Chief of staff yet gets one for this test: a top-level area answered by chiefofstaff.
  let created: string | null = null;
  let coordinator = await readGlobal();
  if (!coordinator.area) {
    const area = await appPost(page, "/api/work/items", { kind: "area", title: `Whitebeam chief ${info.project.name} ${Date.now()}` });
    expect(area.ok(), await area.text()).toBeTruthy();
    created = ((await area.json()) as { item: { id: string } }).item.id;
    const mode = await page.request.patch(`/api/work/items/${created}`, { data: { settings: { agentMode: "chiefofstaff" } }, headers });
    expect(mode.ok(), await mode.text()).toBeTruthy();
    coordinator = await readGlobal();
  }
  expect(coordinator.area, "a Chief of staff area").toBeTruthy();
  const areaId = coordinator.area!.id;
  const make = async (title: string) => {
    const res = await appPost(page, "/api/hermes/sessions", { title, areaId });
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as { id: string }).id;
  };
  const pinned = await make(`Whitebeam pinned ${info.project.name} ${Date.now()}`);
  const other = await make(`Whitebeam other ${info.project.name} ${Date.now()}`);
  const pin = (sessionId: string | null) => page.request.put(`/api/work/items/${encodeURIComponent(areaId)}/coordinator`, { data: { sessionId }, headers });
  const before = coordinator.pinned ? (coordinator.sessionId ?? null) : null;
  const set = await pin(pinned);
  expect(set.ok(), await set.text()).toBeTruthy();
  try {
    await page.goto(`/chat/${pinned}`);
    await expect(page).toHaveURL(/\/chief$/);
    await expect(page.getByRole("heading", { level: 1, name: "Chief of staff" })).toBeAttached();
    // Any other conversation, filed under the same area or not, is still its own chat page.
    await page.goto(`/chat/${other}`);
    await expect(page).toHaveURL(new RegExp(`/chat/${other}$`));
  } finally {
    await pin(before);
    if (created) await page.request.patch(`/api/work/items/${created}`, { data: { archived: true }, headers });
  }
});
