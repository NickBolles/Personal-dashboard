import { expect, test } from "@playwright/test";
import { MOCK_URL, mock, startConversation } from "./helpers";

/**
 * Hermes behind Traefik answers 429 "max connections reached: 10" when too many requests are in
 * flight. Jarvis keeps its own connection budget and retries a 429 with backoff, and when Hermes stays
 * busy it says so plainly instead of failing silently.
 */
test.describe("Hermes busy (429)", () => {
  test.afterEach(async ({ request }) => {
    await mock(request, "/hermes-busy", { count: 0 });
  });

  test("a new chat still opens when Hermes refuses the first attempts", async ({ page, request }) => {
    await mock(request, "/hermes-busy", { count: 2, method: "POST", path: "/api/sessions" });
    await startConversation(page, "Busy gateway check: say hello");
    await expect(page).toHaveURL(/\/chat\/.+/);
    const state = (await (await request.get(`${MOCK_URL}/__mock/state`)).json()) as { hermesBusy: { hits: number; count: number } | null };
    expect(state.hermesBusy?.hits).toBe(2);
    expect(state.hermesBusy?.count).toBe(0);
  });

  test("a clear message when Hermes stays busy", async ({ page, request }) => {
    test.setTimeout(60_000);
    await mock(request, "/hermes-busy", { count: 50, method: "POST", path: "/api/sessions" });
    await page.goto("/chat");
    await page.locator("#quick-capture").fill("Busy gateway check: keep this text");
    await page.getByRole("button", { name: "Send to Hermes", exact: true }).click();
    await expect(page.getByText(/Hermes is busy right now/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/chat\/?$/);
    // The typed text is still there to send again.
    await expect(page.locator("#quick-capture")).toHaveValue("Busy gateway check: keep this text");
  });
});
