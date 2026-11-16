import { expect, test } from "@playwright/test";
import { chatVisual } from "./fixtures/chat-alerts";
import { expectNoHorizontalOverflow } from "./helpers";

for (const theme of ["light", "dark"] as const) {
  test(`delegation: failed steer, raw preservation and menu icons (${theme})`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date());
    const at = await page.evaluate(() => new Date().toISOString());
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    const fixture = {
      ...chatVisual,
      session: { ...chatVisual.session, startedAt: at, lastActiveAt: at },
      timeline: [
        { kind: "user", id: "delegate-user", text: "Use the confirmed variant for the comparison.", at },
        {
          kind: "tool",
          id: "delegate-steer",
          tool: "delegate_task",
          summary: "steer",
          input: JSON.stringify({
            action: "steer",
            subagent_id: "sa-example",
            message: "Use the confirmed variant. Keep the comparison scoped to exact fit and prices.",
          }),
          detail: JSON.stringify({ error: "No live subagent 'sa-example' in this conversation's spawn tree. It may have already finished." }),
          error: true,
          at,
          startedAt: at,
        },
        { kind: "assistant", id: "delegate-answer", text: "The guidance could not be delivered. Check the agent result before continuing.", at },
      ],
    };
    await page.route(/\/api\/hermes\/sessions\/sess_morning$/, (r) => r.fulfill({ json: fixture }));
    await page.route(/\/api\/work\/items(?:\?.*)?$/, (r) => r.fulfill({ json: { items: [] } }));
    await page.route(/\/api\/work\/inbox(?:\?.*)?$/, (r) => r.fulfill({ json: { entries: [], count: 0 } }));
    await page.route(/\/api\/work\/conversations\/unfiled(?:\?.*)?$/, (r) => r.fulfill({ json: { entries: [], conversations: [] } }));
    await page.route(/\/api\/coordinator\/(runs|decisions|looked)(?:\?.*)?$/, (r) => r.fulfill({ json: { runs: [], decisions: [], items: [] } }));
    await page.goto("/chat/sess_morning");
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const guide = page.getByRole("button", { name: /Guide agent/ }).first();
    await expect(guide).toContainText("failed");
    await guide.click();
    const card = page.getByTestId("delegate-details").first();
    await expect(card).toContainText("Use the confirmed variant");
    await expect(card).toContainText("Agent is no longer running; it may have finished.");
    await page.screenshot({
      path: process.env.BOARD_DIR ? `${process.env.BOARD_DIR}/delegate-${info.project.name}-${theme}.png` : info.outputPath(`delegate-${theme}.png`),
      fullPage: true,
    });
    await card.getByText("Raw details", { exact: true }).click();
    await expect(card.locator("pre").last()).toContainText("No live subagent");
    await expectNoHorizontalOverflow(page);
    if (info.project.name === "mobile") {
      await page.getByRole("button", { name: "Add to message", exact: true }).click();
      const menu = page.getByRole("menu", { name: "Add to message" });
      for (const label of ["Context", "Attach file", "Camera", "Photo library", "Model"]) {
        await expect(menu.getByRole("menuitem", { name: new RegExp(`^${label}`) }).locator("svg")).toHaveCount(1);
      }
      await page.screenshot({
        path: process.env.BOARD_DIR ? `${process.env.BOARD_DIR}/menu-${theme}.png` : info.outputPath(`menu-${theme}.png`),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    await page.setViewportSize({ width: 320, height: 850 });
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 412, height: 850 });
    await expectNoHorizontalOverflow(page);
  });
}
