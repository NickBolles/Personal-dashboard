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
export async function expectNoHorizontalOverflow(page: Page) {
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
  expect(r.sw, `${r.path}: scrollWidth ${r.sw} > viewport ${r.cw}: ${r.offenders.join(" | ")}`).toBeLessThanOrEqual(r.cw + 1);
}

export async function startConversation(page: Page, text: string) {
  await page.goto("/home");
  await page.getByLabel("Ask Hermes or capture something").fill(text);
  await page.getByRole("button", { name: "Send to Hermes" }).click();
  await page.waitForURL(/\/chat\/.+/);
}
