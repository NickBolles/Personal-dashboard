import { expect, test } from "@playwright/test";
import { mock, openChatPanel, startConversation } from "./helpers";
import type { ChatExecutionResponse } from "../lib/chat-execution";

test.beforeEach(async ({ request, page }) => {
  await mock(request, "/reset");
  await page.route("**/api/hermes/sessions/*/execution", (route) => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const data: ChatExecutionResponse = {
      sessionId,
      parent: { id: "sess_morning", title: "Parent", href: "/chat/sess_morning" },
      records: [
        {
          key: "subagent:builder",
          id: "builder",
          source: "subagent",
          title: "Panel builder",
          state: "running",
          childSessionId: "child",
          childProfile: "devchief",
          href: "/chat/child",
          step: "Checking types",
        },
      ],
      sources: [{ source: "hermes_children", state: "ok" }],
      fetchedAt: "2026-11-05T00:00:00Z",
    };
    return route.fulfill({ json: data });
  });
});
test("chat panel: tray opens chip tabs, truthful running and parent links", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  await startConversation(page, "quokka chat panel");
  await expect(page.getByText(/Got it: "quokka/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-tray")).toBeVisible();
  const panel = await openChatPanel(page, "Running");
  await expect(page.getByRole("dialog", { name: "In this chat", exact: true })).toBeVisible();
  await expect(panel.getByText("Panel builder")).toBeVisible();
  await expect(panel.getByRole("link", { name: "↩ Back to parent chat" })).toHaveAttribute("href", "/chat/sess_morning");
  await expect(panel.getByRole("link", { name: "Open child chat · @devchief" })).toHaveAttribute("href", "/chat/child");
  for (const tab of ["Links", "Artifacts", "PRs", "Files", "Context", "Running"]) {
    await openChatPanel(page, tab);
    await expect(panel.getByRole("tab", { name: new RegExp(`^${tab}(?:\\s|$)`) })).toHaveAttribute("aria-selected", "true");
  }
  await panel.getByRole("tab", { name: /^Running/ }).press("ArrowRight");
  await expect(panel.getByRole("tab", { name: /^Files/ })).toBeFocused();
  // The sheet's height is set by dragging its grab bar, not by buttons: up for full height, down to close.
  const sheet = page.getByRole("dialog", { name: "In this chat", exact: true });
  await expect(sheet.getByRole("button", { name: /^(Done|Full height|Half height)$/ })).toHaveCount(1);
  const drag = async (by: number) => {
    const box = (await sheet.getByRole("button", { name: /^(Full|Half) height$/ }).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + (by * i) / 8);
    await page.waitForTimeout(150);
    await page.mouse.up();
  };
  const half = (await sheet.boundingBox())!.height;
  await drag(-200);
  await expect(page.locator(".chat-panel-sheet")).toHaveAttribute("data-full", "true");
  await expect.poll(async () => (await sheet.boundingBox())!.height).toBeGreaterThan(half + 100);
  await drag(260);
  await expect(page.locator(".chat-panel-sheet")).toHaveAttribute("data-full", "false");
  await expect(sheet).toBeVisible();
  await drag(half * 0.6);
  await expect(panel).toHaveCount(0);
  // and one Collapse control closes it without a drag
  await openChatPanel(page, "Running");
  await page.getByRole("dialog", { name: "In this chat", exact: true }).getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(panel).toHaveCount(0);
});
test("chat panel desktop: container panel owns rail, resize persists and collapse restores coordinator", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.addInitScript(() => localStorage.setItem("jarvis.gc.open", "true"));
  await startConversation(page, "quokka desktop panel");
  const panel = await openChatPanel(page, "Running");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("gc-rail")).toHaveClass(/gc-strip/);
  const resize = page.getByRole("separator", { name: "Resize chat panel" });
  await resize.focus();
  await resize.press("ArrowLeft");
  await expect(resize).toHaveAttribute("aria-valuenow", "380");
  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize chat panel" })).toHaveAttribute("aria-valuenow", "380");
  await page.getByRole("button", { name: "Collapse chat panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("gc-rail")).toHaveAttribute("data-open", "true");
});
