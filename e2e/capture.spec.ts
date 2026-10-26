import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/** Phase 5 capture: capture sheet with an image, offline queue, AI triage → report ready, capture tokens, staged share. */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function api<T = unknown>(page: Page, method: "get" | "post" | "put" | "delete", path: string, data?: unknown): Promise<T> {
  const r = await page.request[method](path, { data, headers: { "x-jarvis-csrf": "1" } });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}
type Inbox = { items: { id: string; title: string; capture?: { attachments: unknown[]; report: unknown } }[] };

test.describe.configure({ mode: "serial" });

test("capture sheet with an image lands in the inbox with a thumbnail", async ({ page }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/capture");
  await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible();
  await page.getByLabel("Capture to inbox").fill(`Porch light ${nonce}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("img", { name: "shot.png" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page).toHaveURL(/view=inbox/);
  const row = page.locator("[data-inbox-entry]", { hasText: `Porch light ${nonce}` });
  await expect(row).toBeVisible();
  await expect(row.getByRole("img", { name: "Captured image" })).toBeVisible();
  const inbox = await api<Inbox>(page, "get", "/api/work/inbox");
  const e = inbox.items.find((i) => i.title === `Porch light ${nonce}`)!;
  await api(page, "post", `/api/work/inbox/${e.id}/dismiss`);
});

test("offline capture is queued on the phone and delivered exactly once", async ({ page, context }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/capture");
  await page.getByLabel("Capture to inbox").waitFor();
  await context.setOffline(true);
  await page.getByLabel("Capture to inbox").fill(`Offline idea ${nonce}`);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.getByText("Saved on this phone · sends when online")).toBeVisible();
  await context.setOffline(false);
  await page.goto("/capture");
  await expect
    .poll(async () => (await api<Inbox>(page, "get", "/api/work/inbox")).items.filter((i) => i.title === `Offline idea ${nonce}`).length, { timeout: 20_000 })
    .toBe(1);
  await page.reload();
  await page.waitForTimeout(1000);
  const list = (await api<Inbox>(page, "get", "/api/work/inbox")).items.filter((i) => i.title === `Offline idea ${nonce}`);
  expect(list).toHaveLength(1);
  await api(page, "post", `/api/work/inbox/${list[0]!.id}/dismiss`);
});

test("with AI on, a capture is triaged and investigated: Report ready opens the report", async ({ page }) => {
  await api(page, "put", "/api/settings/ai", { enabled: true });
  try {
    const nonce = Date.now().toString(36);
    await page.goto("/areas?view=inbox");
    await page
      .getByRole("button", { name: /Capture/ })
      .first()
      .waitFor();
    const r = await api<{ entry: { id: string }; triage: string }>(page, "post", "/api/capture", { text: `Research standing desks ${nonce}` });
    expect(r.triage).toBe("queued");
    const row = page.locator(`[data-inbox-entry="${r.entry.id}"]`);
    await expect(async () => {
      await page.reload();
      await expect(row.getByTestId("report-ready")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await row.getByTestId("report-ready").click();
    await expect(page.getByRole("dialog", { name: /Findings/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await api(page, "post", `/api/work/inbox/${r.entry.id}/dismiss`);
  } finally {
    await api(page, "put", "/api/settings/ai", { enabled: false });
  }
});

test("finance-looking captures are not sent to AI and say so", async ({ page }) => {
  await api(page, "put", "/api/settings/ai", { enabled: true });
  try {
    const r = await api<{ entry: { id: string }; triage: string; reason: string }>(page, "post", "/api/capture", { text: "Chase checking balance $4,210" });
    expect(r).toMatchObject({ triage: "skipped", reason: "finance_detected" });
    await page.goto("/areas?view=inbox");
    await expect(page.locator(`[data-inbox-entry="${r.entry.id}"]`).getByText("Not sent to AI: looks like finance. File it yourself.")).toBeVisible();
    await api(page, "post", `/api/work/inbox/${r.entry.id}/dismiss`);
  } finally {
    await api(page, "put", "/api/settings/ai", { enabled: false });
  }
});

test("capture tokens: create (shown once), use, revoke", async ({ page }) => {
  const label = `Shortcut ${Date.now().toString(36)}`;
  await page.goto("/settings/phones");
  await page.getByLabel("Label").fill(label);
  await page.getByRole("button", { name: "Create token" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy your capture token" });
  const token = (await dialog.getByTestId("capture-token-value").textContent())!.trim();
  expect(token).toMatch(/^jcap_/);
  await dialog.getByRole("button", { name: "Done" }).click();
  const res = await page.request.post("/api/capture", { data: { text: "from a shortcut" }, headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(201);
  const id = (await res.json()).entry.id;
  expect((await page.request.get("/api/home", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  await page.getByRole("button", { name: `Revoke ${label}` }).click();
  await expect(page.getByText("Revoked").first()).toBeVisible();
  expect((await page.request.post("/api/capture", { data: { text: "x" }, headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  await api(page, "post", `/api/work/inbox/${id}/dismiss`);
});

test("a staged POST share opens the capture sheet prefilled", async ({ page }) => {
  await page.goto("/capture");
  const id = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("jarvis-share", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("staged", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const sid = "e2estaged1";
    await new Promise((res, rej) => {
      const q = db
        .transaction("staged", "readwrite")
        .objectStore("staged")
        .put({ id: sid, title: "Shared title", text: "Shared text", url: "https://example.com/x", files: [], createdAt: new Date().toISOString() });
      q.onsuccess = res;
      q.onerror = () => rej(q.error);
    });
    return sid;
  });
  await page.goto(`/share?staged=${id}`);
  await expect(page).toHaveURL(/\/capture\?staged=/);
  await expect(page.getByLabel("Capture to inbox")).toHaveValue(/Shared title\nShared text/);
  await expect(page.getByText("https://example.com/x")).toBeVisible();
});

type InboxCapture = { id: string; capture?: { triageState: string; suggestion?: { parentId: string } | null } };

test("File it from a Report ready push files under the suggestion once; falls back to the Inbox entry", async ({ page, context }) => {
  await api(page, "put", "/api/settings/ai", { enabled: true });
  const nonce = Date.now().toString(36);
  const made: string[] = [];
  try {
    await page.goto("/areas?view=inbox");
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const area = (await api<{ item: { id: string } }>(page, "post", "/api/work/items", { kind: "area", title: `Porch-${nonce}` })).item;
    const triaged = async (text: string) => {
      const r = await api<{ entry: { id: string } }>(page, "post", "/api/capture", { text });
      made.push(r.entry.id);
      let e: InboxCapture | undefined;
      await expect(async () => {
        const inbox = await api<{ items: InboxCapture[] }>(page, "get", "/api/work/inbox");
        e = inbox.items.find((i) => i.id === r.entry.id);
        expect(e?.capture?.triageState).toBe("done");
      }).toPass({ timeout: 60_000 });
      return { id: r.entry.id, entry: e! };
    };
    const tap = (id: string) =>
      sw.evaluate(
        // handleNotificationClick is a global of public/sw.js
        (url) =>
          (globalThis as unknown as { handleNotificationClick: (a: string, d: unknown, t: string) => Promise<unknown> }).handleNotificationClick(
            "file",
            { url },
            "e2e",
          ),
        `/areas?view=inbox&entry=${id}`,
      ) as Promise<{ filed?: { itemId: string; already: boolean; parentTitle: string }; opened?: string }>;

    const a = await triaged(`Fix the porch light FORCE_DEST=Porch-${nonce}`);
    expect(a.entry.capture?.suggestion?.parentId).toBe(area.id);
    const first = await tap(a.id);
    expect(first.filed).toMatchObject({ already: false, parentTitle: `Porch-${nonce}` });
    const again = await tap(a.id);
    expect(again.filed).toMatchObject({ itemId: first.filed!.itemId, already: true });
    const inbox = await api<{ items: { id: string }[] }>(page, "get", "/api/work/inbox");
    expect(inbox.items.some((i) => i.id === a.id)).toBe(false);

    // No suggestion: the tap opens the Inbox entry instead of filing.
    const b = await triaged(`Random thought ${nonce}`);
    const fallback = await tap(b.id);
    expect(fallback.filed).toBeUndefined();
    expect(fallback.opened).toContain(`view=inbox&entry=${b.id}&do=file`);
    await api(page, "post", `/api/work/inbox/${b.id}/dismiss`);
  } finally {
    await api(page, "put", "/api/settings/ai", { enabled: false });
  }
});

test("Settings → AI: Remove location from captured photos is off by default and can be turned on", async ({ page }) => {
  await page.goto("/settings/ai");
  const box = page.getByRole("checkbox", { name: /Remove location from captured photos/ });
  await expect(box).not.toBeChecked();
  await expect(page.getByText("Dismissed captures, their photos and reports are deleted after 30 days.")).toBeVisible();
  // Controlled by the saved settings: the box flips once the PUT returns.
  await box.click();
  await expect(box).toBeChecked();
  await expect(async () => {
    const s = await api<{ settings: { capture: { stripLocation: boolean } } }>(page, "get", "/api/settings/ai");
    expect(s.settings.capture.stripLocation).toBe(true);
  }).toPass({ timeout: 10_000 });
  await expectNoHorizontalOverflow(page);
  await box.click();
  await expect(box).not.toBeChecked();
  await expect(async () => {
    const s = await api<{ settings: { capture: { stripLocation: boolean } } }>(page, "get", "/api/settings/ai");
    expect(s.settings.capture.stripLocation).toBe(false);
  }).toPass({ timeout: 10_000 });
});
