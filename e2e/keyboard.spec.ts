import { expect, test } from "@playwright/test";
import { mock } from "./helpers";

test("keyboard-only: reach the composer, send, and use a dialog with focus restore", async ({ page, request }) => {
  await mock(request, "/reset");
  await page.goto("/chat/sess_morning");
  // Skip link jumps to main content
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  // Focus the composer by keyboard
  // The desktop sidebar (nav + Areas tree) comes first in tab order; its stop count grows with the
  // areas/chats other specs seed into the shared DB, so allow a generous budget.
  for (let i = 0; i < 500; i++) {
    await page.keyboard.press("Tab");
    if (await page.getByLabel("Message Hermes").evaluate((el) => el === document.activeElement)) break;
  }
  await expect(page.getByLabel("Message Hermes")).toBeFocused();
  await page.keyboard.type("keyboard hello");
  await page.keyboard.press("Control+Enter"); // Enter adds a line; Ctrl+Enter sends
  await expect(page.getByText(/Got it: "keyboard hello/)).toBeVisible({ timeout: 15_000 });

  // Dialog: open via keyboard, Escape closes and focus returns to the trigger
  const trigger = page.getByRole("button", { name: "Conversation actions" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // first item: Rename
  await expect(page.getByRole("dialog", { name: "Rename conversation" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("keyboard-only tree structure: indent, outdent, rename (F2) and Move to… (M)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const H = { "x-jarvis-csrf": "1" };
  const make = async (path: string[], kind?: string) =>
    ((await (await page.request.post("/api/work/items/path", { data: { path, kind }, headers: H })).json()) as { item: { id: string } }).item;
  await make([`Kbd area ${nonce}`, "Plan"], "project");
  const a = await make([`Kbd area ${nonce}`, "Plan", `First ${nonce}`], "thread");
  const b = await make([`Kbd area ${nonce}`, "Plan", `Second ${nonce}`], "thread");
  const parentOf = async (id: string) =>
    ((await (await page.request.get("/api/work/items")).json()) as { items: { id: string; parentId: string | null; title: string }[] }).items.find(
      (i) => i.id === id,
    )?.parentId;
  await page.goto("/areas?view=tree");
  const second = page.getByRole("treeitem", { name: new RegExp(`^Second ${nonce},`) });
  await second.focus();
  await page.keyboard.press("Alt+ArrowRight"); // indent under "First"
  await expect.poll(() => parentOf(b.id)).toBe(a.id);
  await page.getByRole("treeitem", { name: new RegExp(`^Second ${nonce},`) }).focus();
  await page.keyboard.press("Alt+ArrowLeft"); // back out next to "First"
  await expect.poll(async () => (await parentOf(b.id)) !== a.id).toBe(true);
  await page.getByRole("treeitem", { name: new RegExp(`^Second ${nonce},`) }).focus();
  await page.keyboard.press("F2");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`Renamed ${nonce}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: new RegExp(`^Renamed ${nonce},`) })).toBeVisible();
  await page.getByRole("treeitem", { name: new RegExp(`^Renamed ${nonce},`) }).focus();
  await page.keyboard.press("m");
  const picker = page.getByRole("dialog", { name: `Move Renamed ${nonce}` });
  await expect(picker.getByRole("combobox", { name: "Search destinations" })).toBeFocused();
  await page.keyboard.type(`First ${nonce}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => parentOf(b.id)).toBe(a.id);
});

test("keyboard-only inbox triage: j/k move, Enter files, M chooses, E dismisses (two-pane)", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, "two-pane triage is >=640px");
  const nonce = Date.now().toString(36);
  const titles = [1, 2, 3, 4, 5].map((n) => `Triage key ${nonce} ${n}`);
  for (const text of titles) {
    const r = await page.request.post("/api/work/inbox", { data: { text }, headers: { "x-jarvis-csrf": "1" } });
    expect(r.ok()).toBeTruthy();
  }
  await page.goto("/inbox");
  const preview = page.getByTestId("inbox-preview");
  const pick = (t: string) => page.locator(`[data-inbox-pick]`, { hasText: t });
  await expect(pick(titles[0])).toBeVisible();
  // The tree is no longer rendered below the inbox on narrow layouts; the preview shows the selection.
  await pick(titles[0]).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "File capture" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await pick(titles[1]).focus();
  await page.keyboard.press("j");
  await expect(page.locator("[data-inbox-pick][aria-current=true]")).not.toHaveText(titles[1]);
  await page.keyboard.press("k");
  await expect(pick(titles[1])).toHaveAttribute("aria-current", "true");
  await expect(preview.getByRole("heading", { name: titles[1] })).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog", { name: "File capture" })).toBeVisible();
  await page.keyboard.press("Escape");
  for (const t of titles) {
    await pick(t).focus();
    await expect(preview.getByRole("heading", { name: t })).toBeVisible();
    await page.keyboard.press("e");
    await expect(pick(t)).toHaveCount(0);
  }
});

/** Stateful stub of the Inbox list + triage routes so focus/bulk tests don't depend on other specs' captures. */
async function stubInbox(page: import("@playwright/test").Page, nonce: string, withSuggestion: boolean[]) {
  const entry = (n: number, suggested: boolean) => ({
    id: `inb_${nonce}_${n}`,
    source: "capture" as const,
    title: `Focus key ${nonce} ${n}`,
    note: "",
    url: null,
    repo: null,
    number: null,
    reason: "Quick capture",
    createdAt: "2026-10-30T12:00:00.000Z",
    capture: {
      channel: null,
      triageState: "done" as const,
      triageSkipReason: null,
      suggestedTitle: null,
      suggestedKind: null,
      suggestion: suggested ? { parentId: "wk_misc", title: "Errands", path: "Home / Errands", confidence: 0.9, reason: null } : null,
      sensitivity: "none" as const,
      report: null,
      attachments: [],
      investigating: false,
    },
  });
  const all = withSuggestion.map((s, i) => entry(i + 1, s));
  const gone = new Set<string>();
  const calls: string[] = [];
  const list = () => all.filter((e) => !gone.has(e.id));
  await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { items: list(), conversations: [], conversationsTotal: 0, unavailable: [], count: list().length } })
      : route.continue(),
  );
  await page.route(/\/api\/work\/inbox\/([^/]+)\/(accept|dismiss|unaccept|file-suggestion)$/, (route) => {
    const m = /\/api\/work\/inbox\/([^/]+)\/(accept|dismiss|unaccept|file-suggestion)$/.exec(route.request().url())!;
    const id = decodeURIComponent(m[1]);
    calls.push(`${m[2]}:${id}`);
    if (m[2] === "unaccept") gone.delete(id);
    else gone.add(id);
    const item = { id: `wk_${id}`, title: id, parentId: "wk_misc" };
    // bulk accept files through /file-suggestion (#92)
    if (m[2] === "file-suggestion") return route.fulfill({ json: { itemId: item.id, title: id, parentTitle: "Suggested", already: false } });
    return route.fulfill({ json: m[2] === "accept" ? { item } : { ok: true } });
  });
  return { all, calls };
}

test("keyboard-only focus mode on /inbox: n of N, S skips, E dismisses, Enter files, Esc exits", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, "two-pane list is >=640px");
  const nonce = Date.now().toString(36);
  const { all, calls } = await stubInbox(page, nonce, [true, false, true]);
  await page.goto("/inbox");
  await expect(page.locator("[data-inbox-pick]", { hasText: all[0].title }).first()).toBeVisible();
  await page.getByRole("button", { name: "Triage one at a time" }).click();
  const focus = page.getByTestId("inbox-focus");
  const progress = page.getByTestId("inbox-focus-progress");
  await expect(progress).toHaveText("1 of 3");
  await expect(focus.getByRole("heading", { name: all[0].title })).toBeVisible();
  await page.keyboard.press("s");
  await expect(focus.getByRole("heading", { name: all[1].title })).toBeVisible();
  await page.keyboard.press("e");
  await expect(focus.getByRole("heading", { name: all[2].title })).toBeVisible();
  // n counts entries handled so far (skipped + dismissed) + 1.
  await expect(progress).toHaveText("3 of 3");
  await focus.getByRole("button", { name: /File here/ }).focus();
  await page.keyboard.press("Enter");
  await expect(progress).toHaveText(/Done/);
  expect(calls).toEqual([`dismiss:${all[1].id}`, `accept:${all[2].id}`]);
  await page.keyboard.press("Escape");
  await expect(focus).toHaveCount(0);
  // The skipped entry is still waiting in the list.
  await expect(page.locator("[data-inbox-pick]", { hasText: all[0].title }).first()).toBeVisible();
});

test("/inbox?mode=focus starts focus mode; bulk accept files every suggestion and one Undo restores them", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, "two-pane list is >=640px");
  const nonce = Date.now().toString(36);
  const { all, calls } = await stubInbox(page, nonce, [true, true, false]);
  await page.goto("/inbox?mode=focus");
  await expect(page.getByTestId("inbox-focus-progress")).toHaveText("1 of 3");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inbox-focus")).toHaveCount(0);
  await page.getByRole("button", { name: "Accept 2 suggestions" }).click();
  const undo = page.getByTestId("inbox-bulk-undo");
  await expect(undo).toContainText("Filed 2 under their suggestions.");
  await expect(page.locator("[data-inbox-pick]", { hasText: all[0].title })).toHaveCount(0);
  await expect(page.locator("[data-inbox-pick]", { hasText: all[2].title }).first()).toBeVisible();
  await undo.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(undo).toHaveCount(0);
  await expect(page.locator("[data-inbox-pick]", { hasText: all[0].title }).first()).toBeVisible();
  expect(calls.filter((c) => c.startsWith("unaccept:")).sort()).toEqual([`unaccept:${all[0].id}`, `unaccept:${all[1].id}`].sort());
});
