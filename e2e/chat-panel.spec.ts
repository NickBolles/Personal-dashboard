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
  await page.getByRole("dialog", { name: "In this chat", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
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
