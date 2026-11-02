import { expect, test, type Page } from "@playwright/test";
import teaching from "../lib/workflows/fixtures/teaching-notes.json";
import { ensureWorkflowActive } from "./helpers";

/**
 * Workflows W2: palette `/slug args` → prefilled start form (D7) → live run →
 * agent `jarvis-capture` proposal fills the outline → Undo; Place field with
 * saved places (location match is on-device only; geolocation is stubbed).
 */

const fixture = { ...teaching, slug: "livenotes", name: "Live notebook", triggers: [{ kind: "palette", command: "/livenotes" }] };
const H = { "x-jarvis-csrf": "1" };

const ensureActive = (page: Page) => ensureWorkflowActive(page, fixture);

async function openPalette(page: Page, text: string) {
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox")).toBeFocused({ timeout: 1000 });
  }).toPass();
  await page.getByRole("combobox").fill(text);
  await page.getByTestId("palette-workflow").click();
}

/** System Chromium has no geolocation provider: answer from a stub on the device. */
async function stubGeolocation(page: Page, latitude: number, longitude: number) {
  await page.addInitScript(
    ([lat, lng]) => {
      const pos = { coords: { latitude: lat, longitude: lng, accuracy: 20 }, timestamp: Date.now() } as unknown as GeolocationPosition;
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition: (ok: PositionCallback) => setTimeout(() => ok(pos), 10),
          watchPosition: (ok: PositionCallback) => (setTimeout(() => ok(pos), 10), 1),
          clearWatch: () => undefined,
        },
      });
    },
    [latitude, longitude] as const,
  );
}

test("workflow run: prefilled start form → outline fills from the agent → undo", async ({ page }) => {
  // Import first: the palette caches its workflows list on first open.
  await ensureActive(page);
  await page.goto("/workflows");
  await openPalette(page, "/livenotes Ann Lyle John 15");

  const form = page.getByRole("dialog", { name: "New session" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Speaker")).toHaveValue("Ann Lyle");
  await expect(form.getByText("From /livenotes").first()).toBeVisible();
  await expect(form.getByLabel("Place")).toHaveValue("Heartland Sun Prairie");
  await expect(form.getByLabel("Main passage")).toHaveValue("John 15");

  await form.getByTestId("workflow-start-submit").click();
  await expect(page).toHaveURL(/\/chat\//);
  const panel = page.getByTestId("workflow-run");
  await expect(panel).toContainText("Session: Heartland Sun Prairie – Ann Lyle");
  await expect(panel.getByTestId("workflow-outline")).toContainText("John 15");

  // Agent reply carries a jarvis-capture op → applied instantly, undoable.
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.fill("Quote this: remain in me");
  await composer.press("Enter");
  await expect(panel.getByTestId("workflow-outline")).toContainText("Remain in me, as I also remain in you", { timeout: 20_000 });
  // The raw capture block stays in the stored reply but never renders.
  await expect(page.getByText("jarvis-capture")).toHaveCount(0);
  await panel.getByTestId("workflow-undo").click();
  await expect(panel.getByTestId("workflow-outline")).not.toContainText("Remain in me, as I also remain in you");

  // Quick-add chip files the next message straight into that section.
  await panel.getByRole("button", { name: "Point" }).click();
  await composer.fill("Fruit comes from staying connected");
  await composer.press("Enter");
  await expect(panel.getByTestId("workflow-outline")).toContainText("Fruit comes from staying connected");

  await panel.getByRole("button", { name: "End session" }).click();
  await expect(panel).toContainText("Ended");
});

test("workflow start form: place field matches a saved place on the device", async ({ page }) => {
  await ensureActive(page);
  const saved = await page.request.post("/api/workflows/places", { data: { label: "Livenotes Chapel", lat: 43.1836, lng: -89.2137 }, headers: H });
  expect(saved.ok()).toBe(true);
  const { id } = (await saved.json()) as { id: string };
  await stubGeolocation(page, 43.184, -89.2137);
  await page.goto("/workflows");

  await openPalette(page, "/livenotes Ann Lyle");
  const form = page.getByRole("dialog", { name: "New session" });
  await form.getByRole("button", { name: "Use my location" }).click();
  await expect(form.getByTestId("place-geo-status")).toContainText("You're at Livenotes Chapel");
  await expect(form.getByLabel("Place")).toHaveValue("Livenotes Chapel");
  await form
    .getByRole("button", { name: /close|cancel/i })
    .first()
    .click();
  await page.request.delete(`/api/workflows/places/${id}`, { headers: H });
});
