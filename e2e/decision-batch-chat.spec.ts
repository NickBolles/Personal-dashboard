import { expect, test } from "@playwright/test";
import { batchReply, openChat, stubCoordinator } from "./fixtures/decision-batch";
import { expectNoHorizontalOverflow } from "./helpers";

test("batch choices: editable locally, review once, retry same exact reply and reload receipt in originating coordinator", async ({ page }, info) => {
  const now = new Date("2026-11-17T18:00:00Z").getTime();
  await page.clock.setFixedTime(now);
  const state = await stubCoordinator(
    page,
    { "cw-pin": [{ kind: "assistant", id: "batch-fixture", text: batchReply(), at: new Date(now - 60_000).toISOString() }] },
    { current: "cw-pin", now },
  );
  await page.route("**/api/smart/settings", (route) => route.fulfill({ json: { enabled: true, calendarWrites: false } }));
  let fail = true;
  const calls: { input: string; idempotencyKey: string }[] = [];
  await page.route("**/api/hermes/sessions/cw-pin/runs", (route) => {
    calls.push(route.request().postDataJSON());
    return fail
      ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Temporary test failure" } } })
      : route.fulfill({ json: { runId: "batch-run", sessionId: "cw-pin", status: "completed" } });
  });
  await page.goto("/more");
  const scope = await openChat(page, info.project.name === "desktop");
  const batch = scope.getByTestId("answer-batch");
  await expect(batch.getByRole("button", { name: "Submit choices" })).toBeDisabled();
  await batch.getByRole("button", { name: "Birch", exact: true }).click();
  await batch.getByRole("button", { name: "Elm", exact: true }).click();
  await expect(batch.getByRole("button", { name: "Elm", exact: true })).toHaveAttribute("aria-pressed", "true");
  await batch.getByRole("button", { name: "Later", exact: true }).click();
  expect(calls).toHaveLength(0);
  expect(state.runs).toHaveLength(0);
  await batch.getByRole("button", { name: "Submit choices" }).click();
  await batch.getByRole("button", { name: "Cancel review" }).click();
  await page.reload();
  const restored = await openChat(page, info.project.name === "desktop");
  const b = restored.getByTestId("answer-batch");
  await expect(b.getByRole("button", { name: "Elm", exact: true })).toHaveAttribute("aria-pressed", "true");
  await b.getByRole("button", { name: "Submit choices" }).click();
  const exact = await b.getByRole("region", { name: "Review exact reply" }).locator("pre").innerText();
  await b.getByRole("button", { name: "Confirm send reply" }).dblclick();
  await expect(b.getByRole("status")).toContainText("Send not confirmed");
  expect(calls).toHaveLength(1);
  fail = false;
  await b.getByRole("button", { name: "Retry same reply" }).click();
  await expect(b.getByRole("status")).toHaveText("Sent as one reply to this conversation.");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[1].input).toBe(exact);
  expect(exact).toContain("Elm [choice:elm]");
  expect(exact).toContain("Later [choice:later]");
  expect(exact).toContain("question:1:name:name");
  await expectNoHorizontalOverflow(page);
  await page.reload();
  const done = await openChat(page, info.project.name === "desktop");
  await expect(done.getByTestId("answer-batch").getByRole("status")).toHaveText("Sent as one reply to this conversation.");
});

test("batch phone reflow: long generated labels at 320 and 412, 200 percent text and accessible choices", async ({ page }) => {
  const now = new Date("2026-11-17T18:00:00Z").getTime();
  await page.clock.setFixedTime(now);
  const long = batchReply().replace('"label":"Birch"', `"label":"${"Bramble".repeat(25)}"`);
  await stubCoordinator(
    page,
    { "cw-pin": [{ kind: "assistant", id: "long-batch", text: long, at: new Date(now - 60_000).toISOString() }] },
    { current: "cw-pin", now },
  );
  await page.route("**/api/smart/settings", (r) => r.fulfill({ json: { enabled: true, calendarWrites: false } }));
  for (const width of [320, 412]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/more");
    const scope = await openChat(page, false);
    const batch = scope.getByTestId("answer-batch");
    await expect(batch).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.addStyleTag({ content: "html { font-size:200% !important; }" });
    await expectNoHorizontalOverflow(page);
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const result = await new AxeBuilder({ page: page as never })
      .include('[data-testid="answer-batch"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
  }
});

test("batch explicit chat: keyboard choice, typed Other, optional skipped, invalid controls unavailable", async ({ page }) => {
  const now = new Date("2026-11-17T18:00:00Z").getTime();
  await page.clock.setFixedTime(now);
  const text =
    batchReply() +
    "\n```jarvis-ui\n" +
    JSON.stringify({
      root: "bad",
      elements: {
        bad: {
          type: "DecisionCard",
          props: {
            title: "Unsupported",
            options: [
              { id: "bad", label: "Launch", intent: { kind: "money.transfer" } },
              { id: "wait", label: "Wait" },
            ],
          },
        },
      },
    }) +
    "\n```";
  const state = await stubCoordinator(
    page,
    { "cw-pin": [{ kind: "assistant", id: "batch-chat-fixture", text, at: new Date(now - 60_000).toISOString() }] },
    { current: "cw-pin", now },
  );
  await page.route("**/api/smart/settings", (r) => r.fulfill({ json: { enabled: true, calendarWrites: false } }));
  await page.goto("/chat/cw-pin");
  const batch = page.getByTestId("msg-bubble").getByTestId("answer-batch");
  await batch.getByRole("button", { name: "Other", exact: true }).focus();
  await page.keyboard.press("Enter");
  await batch.getByRole("textbox", { name: "Bramble name response" }).fill("Willow");
  await expect(page.getByRole("button", { name: "Launch" })).toHaveCount(0);
  await expect(page.getByTestId("msg-bubble").getByTestId("smart-fallback")).toBeVisible();
  expect(state.runs).toHaveLength(0);
  await batch.getByRole("button", { name: "Submit choices" }).click();
  await batch.getByRole("button", { name: "Confirm send reply" }).click();
  await expect(batch.getByRole("status")).toHaveText("Sent as one reply to this conversation.");
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0].sid).toBe("cw-pin");
  expect(state.runs[0].body.input).toContain("Willow");
  expect(state.runs[0].body.input).toContain("skipped (optional)");
  expect(state.runs[0].body.files).toBeUndefined();
});
