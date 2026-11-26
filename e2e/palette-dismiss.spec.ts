import { expect, test, type Page } from "@playwright/test";
const box = (page: Page) => page.getByRole("combobox", { name: "Search Jarvis" });
async function open(page: Page, command = false) {
  await expect(async () => {
    if (!(await box(page).count())) await page.keyboard.press(command ? "Control+Shift+p" : "Control+k");
    await expect(box(page)).toBeFocused({ timeout: 1000 });
  }).toPass();
}

test("browser Back dismisses all nested palette state, preserves route, and does not swallow another Back on reopen", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  // Real same-document route history underneath the overlay, not a synthetic keydown/popstate.
  await page.evaluate(() => history.pushState(history.state, "", "/home?palette-back=1#kept"));
  const route = page.url();
  for (let i = 0; i < 2; i++) {
    await open(page);
    await page.getByRole("option", { name: /Browse areas/ }).click();
    await expect(page.getByTestId("palette-breadcrumb")).toBeVisible();
    await page.goBack();
    await expect(box(page)).toHaveCount(0);
    await expect(page).toHaveURL(route);
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
});

test("Esc and prominent Close dismiss typed subcommands, restore opener focus, and leave no history stop", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  const opener = page.locator('[data-testid="dock-orb"]:visible').first();
  // Desktop has a different opener; preserve whichever element owned focus before the shortcut.
  if (await opener.count()) await opener.focus();
  await page.evaluate(() => {
    (window as unknown as { paletteOpener: Element | null }).paletteOpener = document.activeElement;
  });
  await open(page);
  await box(page).fill("> new item in");
  await page.locator('[data-command="action.new-item"]').click();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await box(page).press("Escape");
  await expect(box(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement === (window as unknown as { paletteOpener: Element | null }).paletteOpener)).toBe(true);
  await open(page);
  await page.getByRole("button", { name: "Close search (Esc)" }).click();
  await expect(box(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/home$/);
});

test("explicit prefixes edit and switch without sending; commands shortcut and IME are safe", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  let sends = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/sessions(?:\/[^/]+\/runs)?$/.test(new URL(r.url()).pathname)) sends++;
  });
  await open(page, true);
  await expect(box(page)).toHaveValue("> ");
  await box(page).fill("> home");
  await expect(page.locator('[data-command="go.home"]')).toBeVisible();
  await expect(page.getByTestId("palette-ask")).toHaveCount(0);
  await page.getByRole("button", { name: "? Chief", exact: true }).click();
  await expect(box(page)).toHaveValue("? home");
  await expect(page.getByTestId("palette-ask")).toContainText("Ask Chief of staff");
  await box(page).fill("?");
  await box(page).press("Enter");
  await expect(box(page)).toBeVisible();
  await box(page).fill("? draft question");
  await box(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(box(page)).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(box(page)).toHaveValue("draft question");
  await box(page).fill(">");
  await box(page).press("Backspace");
  await expect(box(page)).toHaveValue("");
  expect(sends).toBe(0);
});

test("shell Search resets a previously dismissed Commands mode", async ({ page }) => {
  // The shell header (with its Search button) starts at the tablet breakpoint; phones open search from the orb.
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto("/chat");
  await open(page, true);
  await expect(box(page)).toHaveValue("> ");
  await page.getByRole("button", { name: "Close search (Esc)" }).click();
  await expect(box(page)).toHaveCount(0);
  await page.getByRole("button", { name: /^Search \(/ }).click();
  await expect(box(page)).toHaveValue("");
  await page.getByRole("button", { name: "Close search (Esc)" }).click();
});

test("reload while palette is open leaves no invisible Back stop", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  await page.evaluate(() => history.pushState(history.state, "", "/home?palette-reload=1"));
  await open(page);
  await page.reload();
  await page.getByRole("heading", { name: "Now" }).waitFor();
  await expect(box(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.jarvisPalette))).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
});

test("palette mode surfaces reflow with visible close at phone widths and desktop 200% text", async ({ page }, info) => {
  await page.goto("/home");
  await page.getByRole("heading", { name: "Now" }).waitFor();
  if (info.project.name === "desktop") await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await open(page);
  const dialog = page.getByRole("dialog", { name: "Search", exact: true });
  for (const [mode, value] of [
    ["search", ""],
    ["commands", "> new item in"],
    ["chief", "? plan next steps"],
  ]) {
    await box(page).fill(value!);
    await expect(page.getByRole("button", { name: "Close search (Esc)" })).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`palette-${mode}.png`), animations: "disabled" });
  }
  await box(page).fill("> new item in");
  await page.locator('[data-command="action.new-item"]').click();
  await page.screenshot({ path: info.outputPath("palette-subcommand.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Close search (Esc)" }).click();
  await expect(box(page)).toHaveCount(0);
});
