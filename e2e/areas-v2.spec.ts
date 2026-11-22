import { expect, test, type Page } from "@playwright/test";
import { appPost, openTaskPane } from "./helpers";

/**
 * Areas v2 (N6): an area's view tabs (Overview · Board · Activity · Graph) swap the
 * pane in place and keep the selected node; a task's and a project's bar is Overview · Chat (its own conversation,
 * side by side with room), a project's Board and Graph being views of its Tasks section; the Graph tab is a radial mind map
 * whose nodes re-centre it; /areas/map redirects there. Runs on phone (mobile)
 * and desktop. Titles use Quokka/Wombat/Bilby words no other spec uses.
 */

async function make(page: Page, body: Record<string, unknown>) {
  const r = await appPost(page, "/api/work/items", body);
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { item: { id: string } }).item.id;
}

async function seed(page: Page) {
  const nonce = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const area = await make(page, { kind: "area", title: `Quokka range ${nonce}` });
  const project = await make(page, { kind: "project", title: `Wombat burrow ${nonce}`, parentId: area });
  const item = await make(page, { kind: "thread", title: `Bilby lantern ${nonce}`, parentId: project });
  const other = await make(page, { kind: "thread", title: `Bilby compass ${nonce}`, parentId: project });
  return { nonce, area, project, item, other };
}

const views = (page: Page) => page.getByRole("tablist", { name: "Views" });
const tab = (page: Page, name: string) => views(page).getByRole("tab", { name, exact: true });

test("view tabs keep the selected node and stay in the same spot", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  // An area keeps its four views as tabs.
  await page.goto(`/areas?item=${s.area}`);
  await expect(page.getByRole("heading", { level: 2, name: `Quokka range ${s.nonce}` })).toBeVisible();
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  const top = async () => (await views(page).boundingBox())!.y;
  const y0 = await top();

  await tab(page, "Board").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.area}&tab=board$`));
  await expect(tab(page, "Board")).toHaveAttribute("aria-selected", "true");
  // The node stays named above the pane, and the board is scoped to it.
  await expect(page.getByTestId("node-header")).toContainText(`Quokka range ${s.nonce}`);
  await expect(page.getByTestId("map-row").filter({ hasText: `Bilby lantern ${s.nonce}` })).toBeVisible();
  expect(Math.abs((await top()) - y0)).toBeLessThan(2);

  await tab(page, "Activity").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.area}&tab=activity$`));
  await expect(page.getByTestId("node-header")).toContainText(`Quokka range ${s.nonce}`);

  await tab(page, "Graph").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.area}&tab=graph$`));
  await expect(page.getByTestId("radial-graph").locator(`[data-node-id="${s.area}"][data-centre="true"]`)).toBeVisible();
  expect(Math.abs((await top()) - y0)).toBeLessThan(2);

  // Reload keeps both (URL state), then back to Overview.
  await page.reload();
  await expect(tab(page, "Graph")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Overview").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.area}$`));
  await expect(page.getByRole("heading", { level: 2, name: `Quokka range ${s.nonce}` })).toBeVisible();

  // Keyboard: arrows move between tabs (automatic activation).
  await tab(page, "Overview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Board")).toBeFocused();
  await expect(page).toHaveURL(/tab=board/);

  // A project uses the task page: Overview and Chat. List, Board and Graph are views of its Tasks section,
  // switched in place; each can open full screen, and the bar names that view only while it is open.
  await page.goto(`/areas?item=${s.project}`);
  await expect(page.getByRole("heading", { level: 2, name: `Wombat burrow ${s.nonce}` })).toBeVisible();
  const tasks = page.getByTestId("children-work");
  await expect(tasks.getByTestId("task-row").filter({ hasText: `Bilby lantern ${s.nonce}` })).toBeVisible();
  if (await views(page).count()) await expect(views(page).getByRole("tab")).toHaveText(["Overview", "Chat"]);
  const pick = tasks.getByRole("radiogroup", { name: "View of the tasks" });
  await pick.getByRole("radio", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}$`));
  await expect(tasks.getByTestId("map-row").filter({ hasText: `Bilby lantern ${s.nonce}` })).toBeVisible();
  await tasks.getByRole("button", { name: "Open full screen" }).click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=board$`));
  await expect(page.getByTestId("node-header")).toContainText(`Wombat burrow ${s.nonce}`);
  await expect(views(page).getByRole("tab")).toHaveText(["Overview", "Chat", "Board"]);
  await expect(tab(page, "Board")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Overview").click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}$`));
  await expect(tasks).toBeVisible();

  // A task has ONE tab bar, Overview · Chat. Its old Activity address opens Overview with the log open in place.
  await page.goto(`/areas?item=${s.item}&tab=activity`);
  await expect(page.getByRole("heading", { level: 2, name: `Bilby lantern ${s.nonce}` })).toBeVisible();
  await expect(page.getByTestId("item-log-body")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Item sections" })).toHaveCount(0);
  const panes = page.getByTestId("task-panes");
  if ((await panes.getAttribute("data-split")) !== null) {
    // With room the two panes sit side by side and there is nothing to switch.
    await expect(views(page)).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Overview" })).toBeVisible();
  } else {
    await expect(views(page).getByRole("tab")).toHaveText(["Overview", "Chat"]);
    await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
    await tab(page, "Chat").click();
    await expect(page).toHaveURL(new RegExp(`item=${s.item}&tab=chat$`));
    await expect(page.getByTestId("task-no-chat")).toBeVisible();
    // The old Chats address still opens the task's chat.
    await page.goto(`/areas?item=${s.item}&tab=chats`);
    await expect(tab(page, "Chat")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("task-no-chat")).toBeVisible();
    // Arrow keys move between the two tabs.
    await tab(page, "Chat").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Overview")).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`item=${s.item}$`));
  }
});

test("task page: the first message from the Chat pane creates the task's chat and makes it primary", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas?item=${s.item}`);
  await expect(page.getByRole("heading", { level: 2, name: `Bilby lantern ${s.nonce}` })).toBeVisible();
  const item = async () => ((await (await page.request.get(`/api/work/items/${s.item}`)).json()) as { item: { primarySessionId: string | null } }).item;
  expect((await item()).primarySessionId).toBeNull();
  const chat = await openTaskPane(page, "Chat");
  // Nothing exists before there is a message to put in it.
  await expect(chat.getByTestId("task-no-chat")).toBeVisible();
  expect((await item()).primarySessionId).toBeNull();
  await chat.getByTestId("task-first-input").fill(`quokka first message ${s.nonce}`);
  await chat.getByTestId("task-first-send").click();
  // The same thread as any chat: the message, then the reply, with the composer under it.
  await expect(chat.locator('[data-testid="msg-bubble"][data-who="user"], [data-testid="msg-pending"]').first()).toContainText(
    `quokka first message ${s.nonce}`,
  );
  await expect(chat.getByText(/Got it: "quokka first message/)).toBeVisible({ timeout: 20_000 });
  const primary = (await item()).primarySessionId;
  expect(primary).toBeTruthy();
  // The chat is filed under the task, and it is still the task's chat after a reload.
  const detail = (await (await page.request.get(`/api/work/items/${s.item}`)).json()) as { children: { kind: string; sessionId: string | null }[] };
  expect(detail.children.filter((c) => c.kind === "conversation").map((c) => c.sessionId)).toEqual([primary]);
  await page.reload();
  const again = await openTaskPane(page, "Chat");
  await expect(again.getByText(/Got it: "quokka first message/)).toBeVisible({ timeout: 20_000 });
  await expect(again.getByTestId("task-no-chat")).toHaveCount(0);
});

test("graph: tap a node to re-centre, breadcrumb back out, list fallback", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas?item=${s.area}&tab=graph`);
  const graph = page.getByTestId("radial-graph");
  await expect(graph.locator(`[data-node-id="${s.area}"][data-centre="true"]`)).toBeVisible();
  await graph.locator(`[data-node-id="${s.project}"]`).click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=graph$`));
  await expect(graph.locator(`[data-node-id="${s.project}"][data-centre="true"]`)).toBeVisible();
  await expect(graph.locator(`[data-node-id="${s.item}"][data-ring="1"]`)).toBeVisible();

  // Keyboard: Enter on a focused node re-centres too.
  await graph.locator(`[data-node-id="${s.item}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`item=${s.item}&tab=graph$`));

  // Breadcrumb walks back up without leaving the Graph.
  await page
    .getByRole("navigation", { name: "Graph breadcrumb" })
    .getByRole("button", { name: `Quokka range ${s.nonce}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`item=${s.area}&tab=graph$`));

  // List fallback (screen readers, 200% zoom): the same nodes as buttons.
  await page.getByRole("button", { name: "Show as list" }).click();
  await page
    .getByTestId("graph-tab")
    .getByRole("button", { name: new RegExp(`^Wombat burrow ${s.nonce}`) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`item=${s.project}&tab=graph$`));
});

test("/areas/map redirects to the Graph tab and keeps the query", async ({ page }) => {
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas/map?root=${s.project}&from=bookmark`);
  await expect(page).toHaveURL(new RegExp(`/areas\\?item=${s.project}&tab=graph&from=bookmark$`));
  await expect(page.getByTestId("graph-tab")).toBeVisible();
  await page.goto("/areas/map");
  await expect(page).toHaveURL(/\/areas\?tab=graph$/);
  await expect(page.getByTestId("radial-graph")).toBeVisible();
});

test("desktop: picking a tree row keeps the open tab", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "the side tree is beside the page on desktop only");
  await page.goto("/home");
  const s = await seed(page);
  await page.goto(`/areas?item=${s.item}&tab=graph`);
  await expect(page.getByTestId("radial-graph")).toBeVisible();
  await page.locator(`.jv-side-tree [data-row-id="${s.other}"]`).click();
  await expect(page).toHaveURL(new RegExp(`item=${s.other}&tab=graph$`));
  await expect(page.getByTestId("radial-graph").locator(`[data-node-id="${s.other}"][data-centre="true"]`)).toBeVisible();
});

test("phone overview: areas, needs you, in progress, outstanding", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("desktop"), "phone layout");
  await page.goto("/home");
  const s = await seed(page);
  const p = await page.request.patch(`/api/work/items/${s.item}`, {
    data: { status: "in_progress", nextAction: "Polish the lantern glass" },
    headers: { "x-jarvis-csrf": "1" },
  });
  expect(p.ok(), await p.text()).toBeTruthy();
  await page.goto("/areas");
  const order = await page.evaluate(() =>
    ["map-overview", "map-needs-you-h", "digest-inflight", "digest-outstanding"].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`) ?? document.getElementById(id);
      return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1;
    }),
  );
  // Needs you may be empty (no section) — the rest must be in this order.
  const shown = order.filter((y) => y >= 0);
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
  await expect(page.getByTestId("digest-inflight")).toContainText(`Bilby lantern ${s.nonce}`);
});
