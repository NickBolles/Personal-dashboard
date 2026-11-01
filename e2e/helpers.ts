import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const MOCK_URL = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 4020}`;
export const PASSCODE = "e2e-passcode";

export async function mock(request: APIRequestContext, path: string, body?: unknown) {
  const res = await request.post(`${MOCK_URL}/__mock${path}`, { data: body ?? {} });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function setHa(request: APIRequestContext, entity_id: string, state: string, agoMin = 0) {
  const res = await request.post(`${MOCK_URL}/ha/__mock/ha/set`, {
    data: { entity_id, state, agoMin },
    headers: { authorization: "Bearer mock-ha-long-lived-token" },
  });
  expect(res.ok()).toBeTruthy();
}

/** App API call from the browser context (carries the session cookie + CSRF header). */
export async function appPost(page: Page, path: string, body: unknown = {}) {
  const res = await page.request.post(path, { data: body, headers: { "x-jarvis-csrf": "1" } });
  return res;
}

export async function workerTick(page: Page) {
  const res = await appPost(page, "/api/worker/tick");
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Fail on horizontal overflow (WCAG reflow), naming the widest offenders. */
export async function expectNoHorizontalOverflow(page: Page, opts: { soft?: boolean } = {}) {
  const r = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const b = el.getBoundingClientRect();
      // [data-scroll-x] marks the few wide tables allowed to scroll sideways (the finance grids).
      if (b.width > 0 && b.right > cw + 1 && !el.closest("nav.fixed, [data-scroll-x]"))
        offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    }
    // Text that spills out of its box (not visible via element rects).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const b = range.getBoundingClientRect();
      if (b.width > 0 && b.right > cw + 1 && !n.parentElement?.closest("nav.fixed, .sr-only, [data-scroll-x]"))
        offenders.push(
          `text in ${n.parentElement?.tagName.toLowerCase()}.${String(n.parentElement?.className).slice(0, 40)} "${(n.textContent ?? "").trim().slice(0, 30)}"`,
        );
    }
    return { sw: document.documentElement.scrollWidth, cw, path: location.pathname, offenders: offenders.filter((o) => !o.includes("fixed")).slice(0, 4) };
  });
  (opts.soft ? expect.soft : expect)(r.sw, `${r.path}: scrollWidth ${r.sw} > viewport ${r.cw}: ${r.offenders.join(" | ")}`).toBeLessThanOrEqual(r.cw + 1);
}

export async function startConversation(page: Page, text: string) {
  await page.goto("/home");
  await page.getByLabel("Capture or ask Hermes").fill(text);
  await page.getByRole("button", { name: "Ask Hermes", exact: true }).click();
  await page.waitForURL(/\/chat\/.+/);
}

/** Opens the chat "Add context" sheet: the "+" button on tablets/desktop, the "+" menu → Context on phones. */
export async function openChatContext(page: Page) {
  const direct = page.getByRole("button", { name: "Attach context", exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole("button", { name: "Add to message" }).click();
  await page.getByRole("menuitem", { name: /^Context/ }).click();
}

/** Reveals a chat message's time + actions (hidden until tapped on touch screens). */
export async function revealMessageMeta(page: Page, who: "user" | "assistant", index = 0) {
  const bubble = page.locator(`[data-testid="msg-bubble"][data-who="${who}"]`).nth(index);
  const meta = bubble.locator("xpath=..").getByTestId("msg-meta");
  await expect(bubble.locator("xpath=..")).toHaveCount(1);
  if (!(await isRevealed(meta))) await bubble.click({ position: { x: 4, y: 4 } });
  await expect.poll(() => isRevealed(meta)).toBe(true);
  return meta;
}

async function isRevealed(meta: import("@playwright/test").Locator) {
  return meta.evaluate((el) => el.closest("[data-meta]") !== null || (getComputedStyle(el).position !== "absolute" && getComputedStyle(el).opacity !== "0"));
}
