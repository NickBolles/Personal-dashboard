import { expect, test, type Page } from "@playwright/test";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";
import { ensureWorkflowActive, openChatPanel } from "./helpers";
import { MOCK_URL } from "../playwright.config";

/**
 * #141 Save to Google Drive (mock Drive + OAuth): separate Connect Drive
 * consent → confirm sheet with the exact destination before any write →
 * Google Doc in Teaching notes/<year> → link on the run → disconnect.
 * #142 Offline WEB pack: opt-in download (fixture pack, checksum pinned in
 * playwright.config) → verse text inline in the Scripture field + outline.
 * Unique words ("Juniper") so other specs' filing suggestions never match.
 */

const fixture = {
  ...teaching,
  slug: "junipernotes",
  name: "Juniper notebook",
  triggers: [{ kind: "palette", command: "/junipernotes" }],
};
const H = { "x-jarvis-csrf": "1" };
const year = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric" }).format(new Date());

type DriveState = { files: { id: string; name: string; mimeType: string; parents: string[]; bytes: number }[]; revoked: number; consents: number };
const driveState = async (page: Page) => (await (await page.request.get(`${MOCK_URL}/__mock/drive`)).json()) as DriveState;

test.afterEach(async ({ page }) => {
  // shared server/DB: never leave Drive connected or the pack installed for other specs
  await page.request.delete("/api/integrations/drive", { headers: H });
  await page.request.delete("/api/bible", { headers: H });
});

async function openStartForm(page: Page, command: string) {
  await ensureWorkflowActive(page, fixture);
  await page.goto("/workflows");
  const form = page.getByRole("dialog", { name: "New session" });
  await expect(async () => {
    await page.evaluate((c) => window.dispatchEvent(new CustomEvent("jarvis:workflow-start", { detail: { command: c } })), command);
    await expect(form).toBeVisible({ timeout: 2000 });
  }).toPass();
  return form;
}

test("drive: connect (drive.file), confirm before save, link on the run, disconnect", async ({ page }) => {
  await page.goto("/settings/connections#drive");
  const panel = page.getByTestId("drive-connection");
  await expect(panel).toContainText("drive.file");
  await panel.getByTestId("drive-connect").click();
  await expect(page).toHaveURL(/\/settings\/connections\?drive=connected/);
  await expect(page.getByTestId("drive-connected")).toBeVisible();
  expect((await driveState(page)).consents).toBeGreaterThan(0);

  const form = await openStartForm(page, "/junipernotes Juna Marsh John 15");
  await form.getByTestId("workflow-start-submit").click();
  await expect(page).toHaveURL(/\/chat\//);
  const run = page.getByTestId("workflow-run");
  await openChatPanel(page, "Outline");
  await expect(run.getByTestId("workflow-outline")).toContainText("John 15");
  await run.getByRole("button", { name: "End session" }).click();
  const end = page.getByRole("dialog", { name: "Before you go" });
  if (await end.isVisible().catch(() => false)) await end.getByTestId("workflow-end-submit").click();
  await expect(run).toContainText("Ended");

  const before = (await driveState(page)).files.length;
  await openChatPanel(page, "Outputs");
  await run.getByTestId("workflow-drive-open").click();
  const confirm = page.getByRole("dialog", { name: "Save to Google Drive?" });
  await expect(confirm.getByTestId("workflow-drive-confirm")).toContainText(`My Drive › Teaching notes › ${year()}`);
  await expect(confirm).toContainText("Juna Marsh");
  await expect(confirm).toContainText("Google Doc");
  // nothing is written until Save
  expect((await driveState(page)).files.length).toBe(before);
  await confirm.getByTestId("workflow-drive-save").click();
  await expect(confirm).toBeHidden();
  const saved = run.getByTestId("workflow-drive-saved");
  await expect(saved).toContainText(`Saved to My Drive › Teaching notes › ${year()}`);
  await expect(saved.getByRole("link", { name: "Open in Drive" })).toHaveAttribute("href", /docs\.google\.com\/document\/d\/doc-/);

  const st = await driveState(page);
  const folders = st.files.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
  expect(folders.map((f) => f.name)).toEqual(["Teaching notes", year()]);
  const doc = st.files.find((f) => f.mimeType === "application/vnd.google-apps.document");
  expect(doc?.name).toContain("Juna Marsh");
  expect(doc?.parents).toEqual([folders.find((f) => f.name === year())!.id]);
  expect(doc?.bytes).toBeGreaterThan(0);

  // a second save reuses the folders (created on demand only once)
  await run.getByTestId("workflow-drive-open").click();
  await expect(confirm).toContainText("Saving again creates a new file");
  await confirm.getByTestId("workflow-drive-save").click();
  await expect(confirm).toBeHidden();
  expect((await driveState(page)).files.filter((f) => f.mimeType === "application/vnd.google-apps.folder")).toHaveLength(2);

  await page.goto("/settings/connections#drive");
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await expect(page.getByTestId("drive-connect")).toBeVisible();
  expect((await driveState(page)).revoked).toBe(1);
});

test("bible: opt-in download, verse text inline in the Scripture field and outline", async ({ page }) => {
  await page.goto("/settings/connections#bible");
  const pack = page.getByTestId("bible-pack");
  await expect(pack).toContainText("public domain");
  await pack.getByTestId("bible-download").click();
  await pack.getByRole("button", { name: "Download", exact: true }).click();
  await expect(pack.getByTestId("bible-installed")).toContainText("Downloaded");

  const form = await openStartForm(page, "/junipernotes Juna Marsh John 3:16");
  await expect(form.getByTestId("scripture-passage")).toContainText("For God so loved the world");
  await expect(form.getByTestId("scripture-passage")).toContainText("WEB");
  await form.getByTestId("workflow-start-submit").click();
  await expect(page).toHaveURL(/\/chat\//);
  const outline = page.getByTestId("workflow-run").getByTestId("workflow-outline");
  await openChatPanel(page, "Outline");
  await expect(outline.getByTestId("scripture-passage")).toContainText("For God so loved the world");
  await expect(outline).not.toContainText("Reference only");

  // removing the pack goes back to reference-only
  await page.request.delete("/api/bible", { headers: H });
  await page.reload();
  await openChatPanel(page, "Outline");
  await expect(page.getByTestId("workflow-run").getByTestId("workflow-outline")).toContainText("Reference only");
});
