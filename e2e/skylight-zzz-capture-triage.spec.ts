import { expect, test, type Page } from "@playwright/test";
import { MOCK_URL, expectNoHorizontalOverflow, mock } from "./helpers";

/**
 * Capture AI triage (owner request 2026-11-12) end to end with the mock Hermes + mock Skylight:
 * "add milk to grocery" → Skylight list write, Done chip + Undo, item ready to settle;
 * "dentist appointment" (no time) → Needs you D-n; "open garage" → suggestion only, no write.
 * Sorted after the other Skylight write specs (shared 12 writes/min budget): waits out the minute first.
 */

const H = { "x-jarvis-csrf": "1" };
type Write = { method: string; path: string; body: Record<string, unknown> };
let previous: { enabled: boolean; config: Record<string, string> } | undefined;

async function writes(page: Page): Promise<Write[]> {
  const r = await page.request.get(`${MOCK_URL}/__mock/skylight/writes`);
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { writes: Write[] }).writes;
}
async function api<T = unknown>(page: Page, method: "get" | "post" | "put", path: string, data?: unknown): Promise<T> {
  const r = await page.request[method](path, { data, headers: H });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}
type Entry = { id: string; title: string; capture?: { triage?: { state: string; summary: string; itemId: string | null; decisionRef: string | null } | null } };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(90_000);
  // Earlier Skylight specs may have used this minute's write budget.
  await new Promise((r) => setTimeout(r, 61_000));
});

test.beforeEach(async ({ page, request }) => {
  await mock(request, "/reset");
  const { enabled, config } = await (await page.request.get("/api/integrations/skylight")).json();
  previous = { enabled, config };
  const put = await page.request.put("/api/integrations/skylight", {
    headers: H,
    data: { enabled: true, config: { ...config, mode: "direct", frameId: "4418006", members: "13600771", writes: "true" } },
  });
  expect(put.ok(), await put.text()).toBe(true);
  // The triage prompt lists Skylight lists from the cached snapshot.
  expect((await page.request.get("/api/sources/skylight")).ok()).toBe(true);
  await api(page, "put", "/api/settings/ai", { enabled: true });
});

test.afterEach(async ({ page, request }) => {
  await api(page, "put", "/api/settings/ai", { enabled: false });
  await mock(request, "/reset");
  if (previous)
    await page.request.put("/api/integrations/skylight", {
      headers: H,
      data: {
        enabled: previous.enabled,
        config: { ...previous.config, writes: previous.config.writes ?? "", members: previous.config.members ?? "", frameId: previous.config.frameId ?? "" },
      },
    });
});

async function captureAndWait(page: Page, text: string, until: (e: Entry | undefined, items: Entry[]) => boolean) {
  const r = await api<{ entry: { id: string }; triage: string }>(page, "post", "/api/capture", { text });
  expect(r.triage).toBe("queued");
  let entry: Entry | undefined;
  await expect
    .poll(
      async () => {
        const items = (await api<{ items: Entry[] }>(page, "get", "/api/work/inbox")).items;
        entry = items.find((i) => i.id === r.entry.id);
        return until(entry, items);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return { id: r.entry.id, entry };
}

async function triageOf(page: Page, itemId: string) {
  return (
    await api<{ triage: { id: string; state: string; summary: string; undoable: boolean; decisionRef: string | null } | null }>(
      page,
      "get",
      `/api/capture/triage?item=${itemId}`,
    )
  ).triage;
}

/** The work item a handled capture became (GET /api/capture/<id> → itemId). */
async function itemOf(page: Page, inboxId: string): Promise<string> {
  let itemId = "";
  await expect
    .poll(
      async () => {
        itemId = (await api<{ itemId?: string | null }>(page, "get", `/api/capture/${inboxId}`)).itemId ?? "";
        return itemId !== "";
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return itemId;
}

test("'add milk to grocery' is done on Skylight: Done chip, Undo, item ready to settle", async ({ page }) => {
  const nonce = Date.now().toString(36);
  // Leaves the inbox once handled (filed as a ready-to-settle item).
  const { id } = await captureAndWait(page, `add milk to grocery ${nonce}`, (e) => e === undefined);
  await expect
    .poll(async () => (await writes(page)).filter((w) => w.method === "POST" && w.path.endsWith("/lists/7001/list_items")).length, { timeout: 20_000 })
    .toBe(1);
  expect((await writes(page))[0]!.body).toEqual({ label: "Milk" });
  const item = { id: await itemOf(page, id) };
  expect((await api<{ item: { status: string; title: string } }>(page, "get", `/api/work/items/${item.id}`)).item).toMatchObject({
    status: "ready_to_settle",
    title: "Milk",
  });
  await page.goto(`/areas?item=${encodeURIComponent(item.id)}`);
  const card = page.getByTestId("capture-triage-card");
  await expect(card).toContainText("Done");
  await expect(card).toContainText("added “Milk” to Groceries on Skylight");
  await expectNoHorizontalOverflow(page);
  await card.getByRole("button", { name: /^Undo/ }).click();
  await expect
    .poll(async () => (await writes(page)).some((w) => w.method === "DELETE" && /\/lists\/7001\/list_items\/\d+$/.test(w.path)), { timeout: 20_000 })
    .toBe(true);
  await expect(card).toContainText("Undone");
  expect((await triageOf(page, item.id))!.state).toBe("undone");
  await page.request.patch(`/api/work/items/${item.id}`, { headers: H, data: { archived: true } });
});

test("'dentist appointment' without a time raises one D-n decision (Needs you)", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const { id } = await captureAndWait(page, `dentist appointment ${nonce}`, (e) => e === undefined);
  const item = { id: await itemOf(page, id) };
  const t = await triageOf(page, item.id);
  expect(t).toMatchObject({ state: "needs_input" });
  expect(t!.decisionRef).toMatch(/^D-\d+$/);
  expect((await writes(page)).length).toBe(0);
  await page.goto(`/areas?item=${encodeURIComponent(item.id)}`);
  await expect(page.getByTestId("capture-triage-card")).toContainText("Needs you");
  await expect(page.getByTestId("capture-triage-card")).toContainText(t!.decisionRef!);
  // Clean up: archive it so the decision doesn't leak into later specs' Needs you.
  await page.request.patch(`/api/work/items/${item.id}`, { headers: H, data: { archived: true } });
});

test("'open garage' is only suggested: no Skylight or device write", async ({ page }) => {
  const nonce = Date.now().toString(36);
  const { id } = await captureAndWait(page, `open garage ${nonce}`, (e) => e?.capture?.triage?.state === "suggested");
  expect((await writes(page)).length).toBe(0);
  await page.goto("/inbox");
  const row = page.locator(`[data-inbox-entry="${id}"]`);
  await expect(row.getByTestId("capture-triage")).toContainText("Suggested");
  await expect(row.getByTestId("capture-triage")).toContainText("Open the garage door");
  await expect(row.getByRole("button", { name: /^Do it/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await api(page, "post", `/api/work/inbox/${id}/dismiss`);
});
