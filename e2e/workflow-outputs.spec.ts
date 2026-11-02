import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";
import { ensureWorkflowActive } from "./helpers";

/**
 * Workflows W4: Edit session (#132) → End session (end form) → summary
 * proposal → accept → Markdown download; action checklist → "Create N items?"
 * confirm → work items; workflow page history/stats + reminder toggle.
 * Unique words ("Orchard") so other specs' filing suggestions never match.
 */

const fixture = {
  ...teaching,
  slug: "orchardnotes",
  name: "Orchard notebook",
  reflectionPrompts: "onRequest",
  triggers: [{ kind: "palette", command: "/orchardnotes" }],
};
const H = { "x-jarvis-csrf": "1" };

async function startRun(page: Page) {
  await ensureWorkflowActive(page, fixture);
  await page.goto("/workflows");
  const form = page.getByRole("dialog", { name: "New session" });
  // The start host mounts after hydration: retry the event until the form opens.
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("jarvis:workflow-start", { detail: { command: "/orchardnotes Orla Pike John 15" } })));
    await expect(form).toBeVisible({ timeout: 2000 });
  }).toPass();
  await expect(form.getByLabel("Speaker")).toHaveValue("Orla Pike");
  await form.getByTestId("workflow-start-submit").click();
  await expect(page).toHaveURL(/\/chat\//);
  const panel = page.getByTestId("workflow-run");
  await expect(panel.getByTestId("workflow-outline")).toContainText("John 15");
  return panel;
}

test("workflow outputs: edit session → end form → summary accept → markdown → create items", async ({ page }) => {
  const area = await page.request.post("/api/work/items", { data: { kind: "area", title: "Orchard follow-ups", parentId: null }, headers: H });
  expect(area.ok()).toBe(true);
  const panel = await startRun(page);

  // Edit session (#132): only scalar fields, saved as REPLACE ops.
  await panel.getByTestId("workflow-edit-session").click();
  const edit = page.getByRole("dialog", { name: "Edit session" });
  await expect(edit.getByLabel("Main passage")).toHaveCount(0);
  await edit.getByLabel("Speaker").fill("Orla Pike-Reyes");
  await edit.getByTestId("workflow-edit-save").click();
  await expect(edit).toBeHidden();

  // Two actions via the quick-add chip (no model needed).
  const composer = page.getByRole("textbox", { name: /message/i });
  for (const t of ["Prune the orchard rows", "Call the orchard group"]) {
    await panel.getByRole("button", { name: "Action", exact: true }).click();
    await composer.fill(t);
    await composer.press("Enter");
    await expect(panel.getByTestId("workflow-outline")).toContainText(t);
  }

  // Prompt me (D10) → answer files into reflections.
  await panel.getByTestId("workflow-prompt-me").click();
  const prompt = panel.getByTestId("workflow-reflection");
  await expect(prompt).toContainText("Where will you stay connected this week?");
  await prompt.getByRole("textbox").fill("Orchard walk on Tuesday");
  await prompt.getByRole("button", { name: "Answer" }).click();
  await expect(panel.getByTestId("workflow-outline")).toContainText("Orchard walk on Tuesday");

  // End session: end form first.
  await panel.getByRole("button", { name: "End session" }).click();
  const end = page.getByRole("dialog", { name: "Before you go" });
  await end.getByLabel("One thing to apply this week").fill("Visit the orchard elders");
  await end.getByTestId("workflow-end-submit").click();
  await expect(panel).toContainText("Ended");

  // Summary is a proposal until accepted.
  const summary = panel.getByTestId("workflow-summary");
  await summary.getByTestId("workflow-summary-draft").click();
  await expect(summary.getByTestId("workflow-summary-text")).toHaveValue(/Mock summary/);
  await summary.getByRole("button", { name: "Accept summary" }).click();
  await expect(summary).toContainText("Mock summary: remain in the vine; fruit follows.");

  // Markdown download contains the accepted summary and the session facts.
  const [download] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download Markdown" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^orchardnotes-\d{4}-\d{2}-\d{2}\.md$/);
  const md = await readFile((await download.path())!, "utf8");
  expect(md).toContain("## Summary");
  expect(md).toContain("Orla Pike-Reyes");
  expect(md).toContain("Visit the orchard elders");
  await expect(panel.getByTestId("workflow-export")).toContainText("no Drive connection");

  // Action checklist → confirm sheet with exact titles + destination → items created.
  const actions = panel.getByTestId("workflow-actions");
  await actions.getByLabel("Call the orchard group").check();
  await actions.getByTestId("workflow-actions-create").click();
  const confirm = page.getByRole("dialog", { name: "Create 1 item?" });
  await expect(confirm.getByRole("list", { name: "Items to create" })).toHaveText("Call the orchard group");
  await confirm.getByTestId("workflow-actions-parent").selectOption({ label: "Orchard follow-ups" });
  await confirm.getByTestId("workflow-actions-confirm").click();
  await expect(actions).toContainText("Item created");
  const items = (await (await page.request.get("/api/work/items")).json()) as { items: { title: string; status: string }[] };
  expect(items.items.filter((i) => i.title === "Call the orchard group")).toHaveLength(1);
  expect(items.items.find((i) => i.title === "Prune the orchard rows")).toBeUndefined();
});

test("workflow page: history, stats (plain counts) and reminder toggle", async ({ page }) => {
  await ensureWorkflowActive(page, fixture);
  await page.goto("/workflows/orchardnotes");
  await expect(page.getByRole("heading", { level: 1, name: "Orchard notebook" })).toBeVisible();
  const stats = page.getByTestId("workflow-stats");
  await expect(stats.getByRole("list", { name: "Sessions per month" }).getByRole("listitem")).toHaveCount(12);
  await expect(stats).not.toContainText(/streak|goal|score/i);
  const history = page.getByTestId("workflow-history");
  await expect(history).toBeVisible();
  const reminder = page.getByTestId("workflow-reminder");
  const toggle = reminder.getByRole("switch");
  await expect(toggle).not.toBeChecked();
  const saved = page.waitForResponse((res) => res.url().includes("/reminder") && res.request().method() === "PUT");
  await toggle.check();
  await expect(toggle).toBeChecked();
  await saved;
  await expect(reminder).toContainText("Nothing starts until you tap Start");
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
});

test("share target: Start workflow… opens the start form prefilled from the shared text", async ({ page }) => {
  await ensureWorkflowActive(page, fixture);
  await page.goto("/capture");
  const id = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("jarvis-share", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("staged", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const sid = "e2estagedorchard";
    await new Promise((res, rej) => {
      const q = db
        .transaction("staged", "readwrite")
        .objectStore("staged")
        .put({ id: sid, title: "Wren Hale John 15", text: "Orchard talk notes", url: "", files: [], createdAt: new Date().toISOString() });
      q.onsuccess = res;
      q.onerror = () => rej(q.error);
    });
    return sid;
  });
  await page.goto(`/share?staged=${id}`);
  await expect(page).toHaveURL(/\/capture\?staged=/);
  await page.getByTestId("share-start-workflow").click();
  const picker = page.getByRole("group", { name: "Start a workflow with this" });
  await picker.getByRole("button", { name: "Orchard notebook" }).click();
  const form = page.getByRole("dialog", { name: "New session" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Speaker")).toHaveValue("Wren Hale");
  // Nothing starts until the owner submits.
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toBeHidden();
});

test("reminder notification link (?start=<slug>) opens the start form, never starts a run", async ({ page }) => {
  await ensureWorkflowActive(page, fixture);
  const before = await page.request.get("/api/workflows/runs?limit=200", { headers: H });
  await page.goto("/workflows?start=orchardnotes");
  const form = page.getByRole("dialog", { name: "New session" });
  await expect(form).toBeVisible();
  await expect(page).not.toHaveURL(/start=/);
  await expect(page).toHaveURL(/\/workflows/);
  if (before.ok()) {
    const after = await page.request.get("/api/workflows/runs?limit=200", { headers: H });
    expect(await after.text()).toBe(await before.text());
  }
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toBeHidden();
});
