import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import { setSetting } from "@/server/settings";
import { createPerson } from "@/server/people";
import * as store from "@/server/work/store";
import { globalCoordinatorArea } from "@/server/work/coordinator";
import { GET } from "@/app/api/work/coordinator/global/route";

let user: CurrentUser;
let token: string;
const cid = "global-coordinator-test";
const area = (title: string, mode?: string) => {
  const item = store.createItem(user, { kind: "area", title }, cid);
  if (mode) store.updateItem(user, item.id, { settings: { agentMode: mode } }, cid);
  return item;
};
beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  token = createSession(id).token;
  user = resolveUser(new Headers(), token)!;
});

describe("global coordinator area", () => {
  it("returns null without a suitable area", () => {
    area("General Dev", "devchief");
    expect(globalCoordinatorArea(user)).toBeNull();
  });
  it("uses case-insensitive Portfolio, then mode, then explicit setting", () => {
    const portfolio = area("pOrTfOlIo");
    expect(globalCoordinatorArea(user)?.id).toBe(portfolio.id);
    const chief = area("Ops", "chiefofstaff");
    expect(globalCoordinatorArea(user)?.id).toBe(chief.id);
    const explicit = area("Desk", "devchief");
    setSetting("global_coordinator_area_id", explicit.id);
    expect(globalCoordinatorArea(user)?.id).toBe(explicit.id);
  });
  it("selects the first matching mode in the store's stable order", () => {
    const first = area("First", "chiefofstaff");
    area("Second", "chiefofstaff");
    const expected = store.listItems(user.id).find((i) => i.settings?.agentMode === "chiefofstaff");
    expect(globalCoordinatorArea(user)?.id).toBe(expected?.id ?? first.id);
  });
  it.each(["missing", "archived", "excluded", "nested"])("ignores an invalid configured area: %s", (kind) => {
    const fallback = area("Portfolio");
    const invalid = area("Invalid", "chiefofstaff");
    if (kind === "archived") store.updateItem(user, invalid.id, { archived: true }, cid);
    if (kind === "excluded") store.updateItem(user, invalid.id, { settings: { aiPolicy: "excluded" } }, cid);
    const child = kind === "nested" ? store.createItem(user, { kind: "project", title: "Child", parentId: invalid.id }, cid) : null;
    // A nested item doesn't satisfy top-level area, regardless of its title.
    if (kind === "nested" || kind === "missing") store.updateItem(user, invalid.id, { settings: { agentMode: null } }, cid);
    setSetting("global_coordinator_area_id", kind === "missing" ? "does-not-exist" : (child?.id ?? invalid.id));
    expect(globalCoordinatorArea(user)?.id).toBe(fallback.id);
  });
  it("chooses Finance but never AI-excluded areas, even with the right mode", () => {
    const fin = area("Finance", "chiefofstaff");
    expect(globalCoordinatorArea(user)?.id).toBe(fin.id);
    store.updateItem(user, fin.id, { settings: { aiPolicy: "excluded" } }, cid);
    const excluded = area("Portfolio", "chiefofstaff");
    store.updateItem(user, excluded.id, { settings: { aiPolicy: "excluded" } }, cid);
    expect(globalCoordinatorArea(user)).toBeNull();
  });
  it("cannot resolve another user's area id", () => {
    const owned = area("Foreign desk");
    const other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, user.id);
    const otherUser = resolveUser(new Headers(), createSession(other.id).token)!;
    expect(globalCoordinatorArea(otherUser)).toBeNull();
    setSetting("global_coordinator_area_id", owned.id);
    expect(globalCoordinatorArea(otherUser)).toBeNull();
  });
});

it("requires work.use even for an authenticated person", async () => {
  const person = createPerson({ name: "Kid", username: "kid", role: "kid", passcode: "synthetic-pass" }, user.id);
  const session = createSession(person.id);
  const result = await GET(new NextRequest("http://localhost/api/work/coordinator/global", { headers: { cookie: `jarvis_session=${session.token}` } }), {
    params: Promise.resolve({}),
  });
  expect(result.status).toBe(403);
});

it("the route is authenticated and returns the per-area shape plus global scope", async () => {
  const ctx = { params: Promise.resolve({}) };
  const unauth = await GET(new NextRequest("http://localhost/api/work/coordinator/global"), ctx);
  expect(unauth.status).toBe(401);
  // Auth cookie name matches server/auth. No network or Hermes is called.
  const req = () => new NextRequest("http://localhost/api/work/coordinator/global", { headers: { cookie: `jarvis_session=${token}` } });
  const empty = await GET(req(), ctx);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ area: null });
  const selected = area("Portfolio", "chiefofstaff");
  const result = await GET(req(), ctx);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    area: { id: selected.id, title: "Portfolio" },
    scope: "global",
    sessionId: null,
    excluded: false,
    lastRunAt: null,
  });
});
