import { expect, test } from "@playwright/test";
import { batchReply, openChat, stubCoordinator } from "./fixtures/decision-batch";
import { expectNoHorizontalOverflow } from "./helpers";

test("Chief full chat: generated three-choice Form and prose use compact shared rendering, one Submit", async ({ page }, info) => {
  const now = Date.parse("2026-11-17T18:00:00Z");
  await page.clock.setFixedTime(now);
  const text =
    "Choose the plan.\n```jarvis-ui\n" +
    JSON.stringify({
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["note", "form"] },
        note: { type: "Callout", props: { title: "Discussion only", text: "Pick a direction; nothing is changed.", tone: "info" } },
        form: {
          type: "Form",
          props: {
            title: "Release plan",
            fields: ["Timing", "Scope", "Tone"].map((label) => ({
              id: label.toLowerCase(),
              label,
              kind: "choice",
              required: true,
              options: [
                { value: "one", label: `${label} A` },
                { value: "two", label: `${label} B` },
              ],
            })),
            submit: { label: "Submit" },
          },
        },
      },
    }) +
    "\n```";
  const state = await stubCoordinator(
    page,
    { "cw-pin": [{ kind: "assistant", id: "three-form", text, at: new Date(now - 60_000).toISOString() }] },
    { current: "cw-pin", now },
  );
  await page.route("**/api/smart/settings", (r) => r.fulfill({ json: { enabled: true, calendarWrites: false } }));
  await page.goto("/chief");
  const batch = page.getByTestId("answer-batch");
  await expect(batch.getByText("Release plan", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Discussion only", { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="smart-surface"]')).toHaveCount(0);
  for (const label of ["Timing", "Scope", "Tone"]) await batch.getByRole("button", { name: `${label} B`, exact: true }).click();
  expect(state.runs).toHaveLength(0);
  if (process.env.JARVIS_BATCH_SHOTS) await page.screenshot({ path: `${process.env.JARVIS_BATCH_SHOTS}/three-form-${info.project.name}.png` });
  if (info.project.name === "mobile")
    for (const width of [368, 706]) {
      await page.setViewportSize({ width, height: 850 });
      await expectNoHorizontalOverflow(page);
      if (process.env.JARVIS_BATCH_SHOTS) await page.screenshot({ path: `${process.env.JARVIS_BATCH_SHOTS}/three-form-${width}.png` });
    }
  await batch.getByRole("button", { name: "Submit choices" }).click();
  await expect(batch.getByRole("status")).toHaveText("Sent as one reply to this conversation.");
  expect(state.runs).toHaveLength(1);
  for (const id of ["timing", "scope", "tone"]) expect(state.runs[0].body.input).toContain(`[question:1:form:${id}]`);
  await expect(page.getByRole("dialog", { name: /confirm|review/i })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("Chief mixed run state stays out of Chat after reload; status still leads to Tasks", async ({ page }, info) => {
  const now = Date.parse("2026-11-17T18:00:00Z");
  const iso = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  await page.clock.setFixedTime(now);
  await stubCoordinator(page, { "cw-pin": [{ kind: "assistant", id: "mixed-history", text: "The report is ready.", at: iso(5) }] }, { current: "cw-pin", now });
  const base = { itemTitle: "Release", profile: "devchief", summary: null, prUrl: null, parentRunId: null, parentRef: null, pipeline: [], lock: null, interruptedAt: null, startedAt: iso(100), noticeCount: 0 };
  const runs = [
    { ...base, id: "active", ref: "R-1", seq: 1, itemId: "active", title: "Active run", state: "running", stalled: false, updatedAt: iso(1), finishedAt: null },
    { ...base, id: "stalled", ref: "R-2", seq: 2, itemId: "stalled", title: "Stalled run", state: "running", stalled: true, updatedAt: iso(90), finishedAt: null },
    { ...base, id: "waiting", ref: "R-3", seq: 3, itemId: "waiting", title: "Waiting run", state: "waiting", stalled: false, updatedAt: iso(10), finishedAt: null },
    { ...base, id: "done", ref: "R-4", seq: 4, itemId: "done", title: "Done run", state: "done", stalled: false, updatedAt: iso(5), finishedAt: iso(5) },
  ];
  await page.route("**/api/coordinator/runs", (r) => r.fulfill({ json: { runs, events: [], lastLooked: { chat: iso(1), needs: null, running: null, changes: null, context: null } } }));
  await page.route("**/api/hermes/sessions/cw-pin/execution", (r) => r.fulfill({ json: { sessionId: "cw-pin", parent: null, sources: [{ source: "registered_runs", state: "ok" }], fetchedAt: iso(0), records: runs.map((run) => ({ key: `registered_run:${run.id}`, source: "registered_run", id: run.id, title: run.title, state: run.state, startedAt: run.startedAt, updatedAt: run.updatedAt })) } }));
  for (const width of [320, 412, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/chief");
    await page.reload();
    await expect(page.getByRole("tab", { name: /^Chat/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("coordinator-run-card")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Work in progress" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Work started by this reply" })).toHaveCount(0);
    await expect(page.getByText("The report is ready.", { exact: true })).toBeVisible();
    if (process.env.JARVIS_BATCH_SHOTS) await page.screenshot({ path: `${process.env.JARVIS_BATCH_SHOTS}/mixed-runs-${width}-${info.project.name}.png` });
    await page.getByRole("tab", { name: /^Tasks/ }).click();
    const tasks = page.getByRole("tabpanel", { name: /^Tasks/ });
    await expect(tasks).toBeVisible();
    await expect(tasks.getByTestId("task-list")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("batch choices: ONE Submit sends without review, retry same exact reply and reload receipt in originating coordinator", async ({ page }, info) => {
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
  await page.goto("/settings/agents");
  const scope = await openChat(page, info.project.name === "desktop");
  const batch = scope.getByTestId("answer-batch");
  await expect(batch.getByRole("button", { name: "Submit choices" })).toBeDisabled();
  await batch.getByRole("button", { name: "Birch", exact: true }).click();
  await batch.getByRole("button", { name: "Elm", exact: true }).click();
  await expect(batch.getByRole("button", { name: "Elm", exact: true })).toHaveAttribute("aria-pressed", "true");
  await batch.getByRole("button", { name: "Later", exact: true }).click();
  expect(calls).toHaveLength(0);
  expect(state.runs).toHaveLength(0);
  await page.reload();
  const restored = await openChat(page, info.project.name === "desktop");
  const b = restored.getByTestId("answer-batch");
  await expect(b.getByRole("button", { name: "Elm", exact: true })).toHaveAttribute("aria-pressed", "true");
  await b.getByRole("button", { name: "Submit choices" }).click();
  await expect(b.getByRole("region", { name: "Review exact reply" })).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Confirm send reply" })).toHaveCount(0);
  await expect(b.getByRole("status")).toContainText("Send not confirmed");
  expect(calls).toHaveLength(1);
  const exact = calls[0].input;
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
  for (const width of [320, 368, 412, 706]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/more");
    const scope = await openChat(page, false);
    const batch = scope.getByTestId("answer-batch");
    await expect(batch).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (process.env.JARVIS_BATCH_SHOTS) await page.screenshot({ path: `${process.env.JARVIS_BATCH_SHOTS}/reflow-${width}.png` });
    await page.addStyleTag({ content: "html { font-size:200% !important; }" });
    await expectNoHorizontalOverflow(page);
    await batch.getByRole("button", { name: "Submit choices" }).scrollIntoViewIfNeeded();
    await expect(batch.getByRole("button", { name: "Submit choices" })).toBeVisible();
    if (process.env.JARVIS_BATCH_SHOTS) await page.screenshot({ path: `${process.env.JARVIS_BATCH_SHOTS}/reflow-${width}-zoom.png` });
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
  await expect(batch.getByRole("status")).toHaveText("Sent as one reply to this conversation.");
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0].sid).toBe("cw-pin");
  expect(state.runs[0].body.input).toContain("Willow");
  expect(state.runs[0].body.input).toContain("skipped (optional)");
  expect(state.runs[0].body.files).toBeUndefined();
});
