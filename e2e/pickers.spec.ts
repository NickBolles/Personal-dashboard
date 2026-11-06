import { expect, test } from "@playwright/test";
import { pickOption } from "./helpers";

test("unified pickers: keyboard status, local Tomorrow, overview filter and Escape focus", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const headers = { "x-jarvis-csrf": "1" };
  const area = await page.request.post("/api/work/items", { data: { kind: "area", title: `Larkspur grove ${nonce}` }, headers });
  expect(area.ok(), await area.text()).toBeTruthy();
  const areaId = ((await area.json()) as { item: { id: string } }).item.id;
  const created = await page.request.post("/api/work/items", { data: { kind: "thread", parentId: areaId, title: `Larkspur picker ${nonce}` }, headers });
  expect(created.ok(), await created.text()).toBeTruthy();
  const id = ((await created.json()) as { item: { id: string } }).item.id;
  await page.goto(`/areas?item=${id}`);
  await expect(page.locator("#work-item-title")).toHaveText(`Larkspur picker ${nonce}`);
  const status = page.locator("#work-status");
  await status.click();
  // A tap-opened phone sheet can leave the pointer over another row. Anchor it before keyboard navigation.
  await page.getByRole("option", { name: "Captured", exact: true }).hover();
  const search = page.getByRole("combobox", { name: "Search status" });
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.locator('[data-status="exploring"]')).toBeVisible();
  await expect(status).toHaveAttribute("data-value", "exploring");
  await expect(status).toHaveAttribute("aria-expanded", "false");
  await expect(status).toBeFocused();

  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return {
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      label: `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })}`,
    };
  });
  await pickOption(page, /^Due date:/, "Tomorrow");
  const due = page.getByRole("button", { name: /^Due date:/ });
  await expect(due).toHaveText(tomorrow.label);
  await expect(due).toHaveAttribute("data-value", tomorrow.value);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/work/items/${id}`)).json()) as { item: { status: string; targetDate: string } }).item)
    .toMatchObject({ status: "exploring", targetDate: tomorrow.value });

  await page.goto("/areas");
  const filter = page.getByRole("button", { name: /^Filter by status:/ });
  await pickOption(page, /^Filter by status:/, "Backlog");
  await expect(filter).toHaveAttribute("data-value", "backlog");
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await filter.click();
  await expect(page.getByRole("listbox", { name: "Filter by status" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Filter by status" })).toBeHidden();
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await expect(filter).toBeFocused();
});
