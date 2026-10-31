import { expect, test } from "@playwright/test";
import { mock } from "./helpers";

test("keyboard-only: reach the composer, send, and use a dialog with focus restore", async ({ page, request }) => {
  await mock(request, "/reset");
  await page.goto("/chat/sess_morning");
  // Skip link jumps to main content
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  // Focus the composer by keyboard
  // The desktop sidebar (nav + Areas tree) comes first in tab order.
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    if (await page.getByLabel("Message Hermes").evaluate((el) => el === document.activeElement)) break;
  }
  await expect(page.getByLabel("Message Hermes")).toBeFocused();
  await page.keyboard.type("keyboard hello");
  await page.keyboard.press("Enter");
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
  await page.goto("/areas?view=inbox");
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
