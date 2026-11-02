import { expect, test } from "@playwright/test";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";

/** Workflows W1: gallery, JSON import (as draft) / export, and starting one from the palette with "/slug args". */

const fixture = { ...teaching, slug: "sermonnotes", name: "Sermon notebook", triggers: [{ kind: "palette", command: "/sermonnotes" }] };

test("workflows: import as draft, export, turn on, start from the palette", async ({ page }) => {
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Built-in workflows" })).toContainText("Morning brief");

  await page
    .getByLabel("Workflow JSON file")
    .setInputFiles({ name: "sermon.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
  await expect(page.getByRole("status").filter({ hasText: "Imported /sermonnotes as a draft." })).toBeVisible();
  const card = page.getByTestId("workflow-card").filter({ hasText: "Sermon notebook" });
  await expect(card).toContainText("Draft");

  // Re-import of the same file is a no-op; a Finance-targeted one is refused.
  await page
    .getByLabel("Workflow JSON file")
    .setInputFiles({ name: "sermon.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
  await expect(page.getByRole("status")).toContainText("already here");
  const bad = { ...fixture, slug: "moneynotes", triggers: [], routing: { area: "Finance", modelTier: "fast" } };
  await page.getByLabel("Workflow JSON file").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.getByRole("status")).toContainText("Not imported");

  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Export Sermon notebook" }).click()]);
  const exported = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
  expect(exported.workflows[0].slug).toBe("sermonnotes");

  await card.getByRole("button", { name: "Turn on Sermon notebook" }).click();
  await expect(card).toContainText("On");

  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox")).toBeFocused({ timeout: 1000 });
  }).toPass();
  await page.getByRole("combobox").fill("/sermonnotes Jake Fry");
  const row = page.getByTestId("palette-workflow");
  await expect(row).toContainText("Start Sermon notebook");
  await row.click();
  // W2: the start form is always shown (D7), prefilled; one tap starts.
  await page.getByTestId("workflow-start-submit").click();
  await expect(page).toHaveURL(/\/chat\//);
  await expect(page.getByRole("heading", { name: "Session: Heartland Sun Prairie – Jake Fry", level: 1 })).toBeVisible();
  await expect(page.getByText("Context Jarvis attached").first()).toBeAttached();
});

test("workflows: import with an unknown area → pick one (#117), then Undo import archives it (#116)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const areaTitle = `Medlar yard ${nonce}`;
  const made = await page.request.post("/api/work/items", { data: { kind: "area", title: areaTitle }, headers: { "x-jarvis-csrf": "1" } });
  expect(made.ok()).toBe(true);
  const slug = `medlarlog${nonce}`.slice(0, 40);
  const def = {
    ...teaching,
    slug,
    name: `Medlar log ${nonce}`,
    triggers: [{ kind: "palette", command: `/${slug}` }],
    routing: { ...teaching.routing, area: "No such shed" },
  };
  await page.goto("/workflows");
  await page.getByLabel("Workflow JSON file").setInputFiles({ name: "medlar.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(def)) });
  const status = page.getByRole("status").filter({ hasText: `Imported /${slug} as a draft.` });
  await expect(status).toContainText("area wasn't found");
  await status.getByLabel(`Area for /${slug}`).selectOption(areaTitle);
  await expect(status).not.toContainText("area wasn't found");
  await expect
    .poll(async () => {
      const list = (await (await page.request.get("/api/workflows")).json()) as { workflows: { slug: string; area: string | null }[] };
      return list.workflows.find((w) => w.slug === slug)?.area ?? null;
    })
    .toBe(areaTitle);

  const card = page.getByTestId("workflow-card").filter({ hasText: `Medlar log ${nonce}` });
  await expect(card).toBeVisible();
  await status.getByRole("button", { name: "Undo import" }).click();
  await expect(card).toHaveCount(0);
  await expect(status.getByRole("button", { name: "Undo import" })).toHaveCount(0);
});

test("settings: saved places list, rename and delete (#133)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const label = `Juniper hall ${nonce}`;
  const made = await page.request.post("/api/workflows/places", { data: { label, lat: 43.1, lng: -89.2 }, headers: { "x-jarvis-csrf": "1" } });
  expect(made.ok()).toBe(true);
  await page.goto("/settings/places");
  await expect(page.getByRole("heading", { name: "Saved places", level: 1 })).toBeVisible();
  const row = page.getByTestId("places-list").getByRole("listitem").filter({ hasText: label });
  await expect(row).toContainText("43.1000, -89.2000");
  await row.getByRole("button", { name: `Rename ${label}` }).click();
  await page.getByLabel(`New name for ${label}`).fill(`Juniper chapel ${nonce}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const renamed = page
    .getByTestId("places-list")
    .getByRole("listitem")
    .filter({ hasText: `Juniper chapel ${nonce}` });
  await expect(renamed).toBeVisible();
  await renamed.getByRole("button", { name: `Delete Juniper chapel ${nonce}` }).click();
  await renamed.getByRole("button", { name: `Confirm delete Juniper chapel ${nonce}` }).click();
  await expect(renamed).toHaveCount(0);
});
