import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";
import { openPrismChat, stubPrismV2 } from "./fixtures/smart-v2";

test("Prismv2 weekly dynamic line → sheet → form → confirm Apply → Undo", async ({ page }) => {
  const read = await stubPrismV2(page);
  await page.goto("/more");
  const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
  await expect(tray).toContainText("Weekly review");
  await tray.click();
  const sheet = page.getByRole("dialog", { name: "Chief of staff", exact: true });
  await expect(sheet.getByRole("heading", { name: "Prismv2 weekly review" })).toBeVisible();
  await sheet.getByLabel("How did the week go?", { exact: false }).selectOption("4");
  await sheet.getByLabel("Top 3 for next week", { exact: false }).fill("Prismv2 polish the fixture");
  await sheet.getByLabel("Create under", { exact: false }).selectOption("item:prism");
  await sheet.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(sheet.getByTestId("smart-tray-count")).toHaveText("1 change staged");
  expect(read().applied).toHaveLength(0);
  await sheet.getByRole("button", { name: "Apply 1 change", exact: true }).click();
  await page.getByRole("button", { name: "Confirm apply", exact: true }).click();
  await expect(sheet.getByText("✓ 1 applied", { exact: true })).toBeVisible();
  expect(read().applied[0]?.intent).toMatchObject({ kind: "item.create", title: "Prismv2 polish the fixture", parentRef: "item:prism" });
  await sheet.getByRole("button", { name: "Undo latest smart change" }).click();
  await expect.poll(() => read().applied[0]?.undone).toBe(true);
});

test("Prismv2 matrix in chat: weight → choose → Apply → Undo", async ({ page }) => {
  const read = await stubPrismV2(page, []);
  await openPrismChat(page);
  const surface = page.getByTestId("smart-surface").first();
  const matrix = surface.getByRole("region", { name: "Prismv2 routing choice", exact: true });
  await matrix.getByRole("button", { name: "Raise weight: Speed" }).click();
  await expect(matrix.getByLabel("Weight: Speed", { exact: true })).toHaveText("2");
  await matrix.getByRole("button", { name: "Patch Prismv2", exact: true }).click();
  await expect(surface.getByTestId("smart-tray-count")).toHaveText("1 change staged");
  await surface.getByRole("button", { name: "Apply 1 change", exact: true }).click();
  await page.getByRole("button", { name: "Confirm apply", exact: true }).click();
  await expect.poll(() => read().applied.length).toBe(1);
  expect(read().applied[0]?.intent).toMatchObject({ kind: "item.update", patch: { nextAction: "Decided: Patch Prismv2" } });
  await matrix.getByRole("button", { name: "Undo: Prismv2 routing choice" }).click();
  await expect.poll(() => read().applied[0]?.undone).toBe(true);
});

test("Prismv2 dynamic card sheet is WCAG 2.2 AA and reflows at 320px / 200% text", async ({ page }) => {
  await stubPrismV2(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/more");
  // Open the tray only once the dynamic line has loaded: an earlier tap opens the sheet on Chat.
  const tray = page.getByRole("button", { name: "Chief of staff", exact: true });
  await expect(tray).toContainText("Weekly review");
  await tray.click();
  await expect(page.getByTestId("dynamic-card")).toBeVisible();
  const axe = await new AxeBuilder({ page: page as never }).include(".gc-sheet").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectNoHorizontalOverflow(page);
  expect(await page.getByTestId("dynamic-card").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Close Chief of staff", exact: true }).click();
  await expect(page.getByRole("button", { name: "Chief of staff", exact: true })).not.toContainText("Weekly review");
  await page.reload();
  await expect(page.getByRole("button", { name: "Chief of staff", exact: true })).not.toContainText("Weekly review");
});
