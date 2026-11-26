import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectNoHorizontalOverflow, openChatPanel, startConversation } from "./helpers";
import type { ChatExecutionResponse } from "../lib/chat-execution";

const at = "2026-11-24T18:22:00.000Z";

function fixture(sessionId: string): ChatExecutionResponse {
  return {
    sessionId,
    parent: { id: "sess_parent", title: "Release planning", href: "/chat/sess_parent" },
    fetchedAt: at,
    sources: [{ source: "registered_runs", state: "ok", at }],
    records: [
      {
        key: "registered_run:r98-parent",
        source: "registered_run",
        id: "run_parent",
        delegationId: "delegate:real-98",
        title: "Verify mobile execution receipts without changing the owner chat.",
        state: "running",
        updatedAt: at,
        step: "Capturing 368px evidence",
        progress: 0.5,
        task: { id: "wk_ee4334a0-ccc4-42a4-989e-ec08ff3a302c", title: "In-chat metadata polish", href: "/areas?item=wk_ee4334a0-ccc4-42a4-989e-ec08ff3a302c" },
        run: { id: "run_parent", ref: "R-98", events: [{ type: "progress", summary: "evidence capture started", at }] },
        sourceChat: { id: "sess_parent", href: "/chat/sess_parent" },
        links: [
          { kind: "github", label: "PR #296", url: "https://github.com/NickBolles/Personal-dashboard/pull/296" },
          { kind: "artifact", label: "Evidence board", url: "https://artifacts.ai.nickbolles.com/a/jarvis-delegation-icons-20261116" },
        ],
      },
      {
        key: "subagent:child-failed",
        source: "subagent",
        id: "sa-child",
        subagentId: "sa-child",
        delegationId: "delegate:real-98",
        title: "Child receipt failed after collecting a useful artifact.",
        state: "failed",
        updatedAt: at,
        error: "Mock failure retained visibly.",
        transcriptPath: "/home/hermes/.hermes/profiles/devchief/cache/receipts/child.json",
      },
      {
        key: "subagent:colliding",
        source: "subagent",
        id: "sa-0",
        subagentId: "sa-0",
        delegationId: "delegate:other",
        title: "Independent same local handle remains separate.",
        state: "waiting",
        approval: true,
        updatedAt: at,
      },
      {
        key: "process:complete",
        source: "process",
        id: "p-done",
        title: "A finished run retains its event history after reload.",
        state: "completed",
        updatedAt: at,
        summary: "Delivered mock receipt.",
      },
      {
        key: "subagent:malformed",
        source: "subagent",
        id: "sa-malformed",
        title: "/home/hermes/.hermes/profiles/devchief/cache/very-long-goal.md",
        state: "unknown",
        updatedAt: at,
      },
    ],
  };
}

test("in this chat: mock-backed execution receipts retain detail, navigation and history", async ({ page, context }, info) => {
  test.skip(!["mobile", "desktop"].includes(info.project.name));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let recordLimit: number | null = null;
  const shot = async (name: string) =>
    page.screenshot({
      path: process.env.BOARD_DIR ? `${process.env.BOARD_DIR}/${info.project.name}-${name}.png` : info.outputPath(`${name}.png`),
      animations: "disabled",
      caret: "hide",
    });
  await page.route("**/api/hermes/sessions/*/execution", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const data = fixture(id);
    if (recordLimit !== null) data.records = data.records.slice(0, recordLimit);
    return route.fulfill({ json: data });
  });
  await startConversation(page, "in this chat receipt fixture");
  const panel = await openChatPanel(page, "Running");
  await expect(panel.getByText("Verify mobile execution receipts", { exact: false }).first()).toBeVisible();
  await expect(panel.getByText("Mock failure retained visibly.")).toBeVisible();
  await expect(panel.getByText("No agents or jobs for this chat")).toHaveCount(0);
  await expect(panel.getByText("/home/hermes/.hermes/profiles/devchief/cache/very-long-goal.md")).not.toBeVisible();
  await shot("multiple-collapsed");

  const running = panel.locator(".cp-run", { hasText: "Verify mobile execution receipts" });
  await running.locator("summary.cp-run-summary").focus();
  await page.keyboard.press("Enter");
  await expect(running.getByText("In-chat metadata polish")).toBeVisible();
  await expect(running.getByText("R-98", { exact: false })).toBeVisible();
  await running.getByText("Details and copy", { exact: false }).click();
  await running.getByRole("button", { name: "Copy stored brief" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Verify mobile execution receipts");
  await expect(running.getByRole("link", { name: "In-chat metadata polish" })).toHaveAttribute("href", /areas\?item=wk_/);
  await expect(running.getByRole("link", { name: "Open source chat" })).toHaveAttribute("href", "/chat/sess_parent");

  for (const width of [320, 368, 412, 706]) {
    await page.setViewportSize({ width, height: 850 });
    await expectNoHorizontalOverflow(page);
    await shot(`expanded-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  await expectNoHorizontalOverflow(page);
  const axe = await new AxeBuilder({ page: page as never }).include('[data-testid="chat-panel-content"]').analyze();
  expect(axe.violations, axe.violations.map((v) => `${v.id}: ${v.help}`).join("\n")).toEqual([]);

  await page.screenshot({
    path: process.env.BOARD_DIR ? `${process.env.BOARD_DIR}/in-this-chat-${info.project.name}.png` : info.outputPath("in-this-chat.png"),
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await page.reload();
  const reloaded = await openChatPanel(page, "Running");
  const reloadedRunning = reloaded.locator(".cp-run", { hasText: "Verify mobile execution receipts" });
  await reloadedRunning.locator("summary.cp-run-summary").focus();
  await page.keyboard.press("Enter");
  await expect(reloaded.getByText("evidence capture started")).toBeVisible();
  await expect(reloaded.getByText("Mock failure retained visibly.")).toBeVisible();
  await expect(reloaded.getByRole("link", { name: "Open source chat" })).toHaveAttribute("href", "/chat/sess_parent");
  await page.setViewportSize({ width: 412, height: 850 });
  recordLimit = 0;
  await page.reload();
  let sparse = await openChatPanel(page, "Running");
  await expect(sparse.getByText("No agents or jobs for this chat")).toBeVisible();
  await shot("zero-records-412");
  recordLimit = 1;
  await page.reload();
  sparse = await openChatPanel(page, "Running");
  await expect(sparse.locator(".cp-run")).toHaveCount(1);
  await shot("single-record-412");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot("single-dark-412");
});
