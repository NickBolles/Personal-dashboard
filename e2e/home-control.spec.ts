import { expect, test } from "@playwright/test";
import { appPost, mock, setHa } from "./helpers";

test.beforeEach(async ({ request }) => {
  await mock(request, "/reset");
});

test("allowlisted control requires confirmation and reports success only after readback", async ({ page, request }) => {
  await setHa(request, "cover.garage_door", "open", 20);
  await page.goto("/home-control?entity=cover.garage_door");
  const card = page.locator("section[aria-labelledby=ctl-h] li", { hasText: "Garage door" }).first();
  await expect(card).toContainText("open");
  await card.getByRole("button", { name: "Close Garage door" }).click();
  const dialog = page.getByRole("dialog", { name: /Close Garage door\?/ });
  await expect(dialog).toContainText("Current state: open");
  await dialog.getByRole("button", { name: /Yes, close/ }).click();
  await expect(page.getByText("Waiting for Home Assistant to confirm…")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Confirmed: closed" })).toBeVisible({ timeout: 15_000 });
});

test("state changed since the user looked → rejected, nothing sent", async ({ page, request }) => {
  await setHa(request, "lock.front_door_lock", "unlocked");
  await page.goto("/home-control");
  const card = page.locator("section[aria-labelledby=ctl-h] li", { hasText: "Front door lock" }).first();
  await expect(card).toContainText("unlocked");
  await card.getByRole("button", { name: "Lock Front door lock", exact: true }).click();
  // Someone locks it physically before we confirm
  await setHa(request, "lock.front_door_lock", "locked");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: /I mean it/ }).check();
  await dialog.getByRole("button", { name: /Yes, lock/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /State changed/ })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
  expect(state.haCalls.filter((c: { service: string }) => c.service === "lock")).toHaveLength(0);
});

test("lock and unlock are high-risk: the confirm card names the device and needs an explicit tick", async ({ page, request }) => {
  await page.goto("/home-control");
  const controls = page.locator("section[aria-labelledby=ctl-h]");
  await controls.getByRole("button", { name: "Unlock Front door lock" }).click();
  const dialog = page.getByRole("dialog", { name: /Unlock Front door lock\?/ });
  await expect(dialog).toContainText("Current state: locked");
  await expect(dialog).toContainText("High-risk: this operates Front door lock.");
  const yes = dialog.getByRole("button", { name: /Yes, unlock/ });
  await expect(yes).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I mean it: unlock Front door lock \(now locked\)/ }).check();
  await yes.click();
  const done = page.getByRole("status").filter({ hasText: "Front door lock: Confirmed: unlocked" });
  await expect(done).toBeVisible({ timeout: 15_000 });
  const state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
  expect(state.haCalls.filter((c: { service: string }) => c.service === "unlock")).toHaveLength(1);
  // Undo = lock again, still high-risk → the confirm card comes back.
  await done.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("dialog", { name: /Lock Front door lock\?/ })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
});

test("garage: Open (high-risk) and Close are each other's Undo", async ({ page }) => {
  await page.goto("/home-control?entity=cover.garage_door_2");
  const card = page.locator("section[aria-labelledby=ctl-h] li", { hasText: "Garage door 2" }).first();
  await expect(card).toContainText("closed");
  await card.getByRole("button", { name: "Open Garage door 2" }).click();
  const open = page.getByRole("dialog", { name: /Open Garage door 2\?/ });
  await expect(open.getByRole("button", { name: /Yes, open/ })).toBeDisabled();
  await open.getByRole("checkbox", { name: /I mean it/ }).check();
  await open.getByRole("button", { name: /Yes, open/ }).click();
  const opened = page.getByRole("status").filter({ hasText: "Garage door 2: Confirmed: open" });
  await expect(opened).toBeVisible({ timeout: 15_000 });
  await opened.getByRole("button", { name: "Undo" }).click();
  const close = page.getByRole("dialog", { name: /Close Garage door 2\?/ });
  await expect(close.getByRole("checkbox")).toHaveCount(0);
  await close.getByRole("button", { name: /Yes, close/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Garage door 2: Confirmed: closed" })).toBeVisible({ timeout: 15_000 });
});

test("lights: a tap switches with readback and Undo switches back", async ({ page, request }) => {
  await page.goto("/home-control");
  const sw = page.getByRole("switch", { name: "Porch light: off, turn on" });
  await sw.click();
  const done = page.getByRole("status").filter({ hasText: "Porch light: Confirmed: on" });
  await expect(done).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("switch", { name: "Porch light: on, turn off" })).toBeVisible();
  await done.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Porch light: Confirmed: off" })).toBeVisible({ timeout: 15_000 });
  const state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
  expect(state.haCalls.filter((c: { domain: string }) => c.domain === "light").map((c: { service: string }) => c.service)).toEqual(["turn_on", "turn_off"]);
});

test("an agent's device proposal becomes a decision and only the owner's confirm runs it", async ({ page, request }) => {
  const nonce = Date.now().toString(36);
  await page.goto("/home");
  const area = await (await appPost(page, "/api/work/items", { kind: "area", title: `Quokkahaven ${nonce}` })).json();
  const areaId = (area.item ?? area).id as string;
  const minted = await appPost(page, "/api/settings/agents/tokens", {
    name: `Quokka ${nonce}`,
    profile: `qk${nonce}`.slice(0, 30),
    scopes: ["work.read", "decisions.write"],
  });
  expect(minted.ok()).toBeTruthy();
  const { token, view } = await minted.json();
  try {
    const r = await page.request.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}` },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "jarvis_propose_device_change",
          arguments: { itemId: areaId, entityId: "lock.front_door_lock", service: "unlock", reason: "Quokka guest" },
        },
      },
    });
    const body = await r.json();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent).toMatchObject({ proposed: true, executed: false, risk: "high" });
    let state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
    expect(state.haCalls.filter((c: { domain: string }) => c.domain === "lock")).toHaveLength(0);
    // #238: the decision carries a tappable "Confirm on House" action that opens the confirm card;
    // nothing runs until the owner ticks and confirms.
    await page.goto(`/decisions/${encodeURIComponent(`item:${areaId}`)}`);
    const go = page.getByRole("link", { name: "Confirm on House" });
    await expect(go).toHaveAttribute("href", body.result.structuredContent.confirmAt);
    await go.click();
    await expect(page).toHaveURL(/\/home-control\?entity=lock\.front_door_lock&propose=unlock/);
    const dialog = page.getByRole("dialog", { name: /Unlock Front door lock\?/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Yes, unlock/ })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    state = await (await request.get("http://127.0.0.1:4020/__mock/state")).json();
    expect(state.haCalls.filter((c: { domain: string }) => c.domain === "lock")).toHaveLength(0);
  } finally {
    await page.request.delete(`/api/settings/agents/tokens/${view.id}`, { headers: { "x-jarvis-csrf": "1" } });
    await page.request.patch(`/api/work/items/${areaId}`, { data: { archived: true }, headers: { "x-jarvis-csrf": "1" } });
  }
});

test("controls are disabled offline and never queued", async ({ page, context }) => {
  await page.goto("/home-control");
  await expect(page.locator("section[aria-labelledby=ctl-h] button").first()).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText(/Controls are disabled while offline/)).toBeVisible();
  for (const b of await page.locator("section[aria-labelledby=ctl-h] li button").all()) await expect(b).toBeDisabled();
  await context.setOffline(false);
});

test("ask Hermes about my home attaches a snapshot of what Jarvis sees", async ({ page, request }) => {
  await setHa(request, "cover.garage_door", "open", 30);
  await page.goto("/home-control");
  await expect(page.locator("section[aria-labelledby=ctl-h] li").first()).toBeVisible();
  await page.getByRole("link", { name: "Ask Hermes about my home" }).click();
  await expect(page).toHaveURL(/\/chat\?new=1&context=/);
  const context = decodeURIComponent(new URL(page.url()).searchParams.get("context") ?? "");
  expect(context).toContain("Garage door (cover.garage_door)");
  expect(context).toContain("Health:");
});

test("a paused media player counts as powered on (#246)", async ({ page }) => {
  await page.goto("/home-control");
  const sw = page.getByRole("switch", { name: /^Living room speaker: on, turn off$/ });
  await expect(sw).toBeVisible();
  await expect(sw).toHaveAttribute("aria-checked", "true");
});
