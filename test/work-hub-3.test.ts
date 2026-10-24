import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { areaValidationDefault, packetSchema } from "@/lib/work";
import * as store from "@/server/work/store";
import * as itemRoute from "@/app/api/work/items/[id]/route";
import * as packetsRoute from "@/app/api/work/items/[id]/packets/route";

/** Work hub phase 3 (docs/work.md): owner decisions, GitHub connections, poller, webhooks, inbox. */

let owner: string, other: string, kid: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Child", username: "child", role: "kid", passcode: "synthetic-pass" }, owner).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type H = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(
  handler: H,
  opts: { user?: string | null; method?: string; body?: unknown; csrf?: boolean; params?: Record<string, string>; query?: string; path?: string } = {},
) {
  const { user = owner, method = "GET", body, csrf = true, params = {}, query = "", path = "/api/work" } = opts;
  return handler(
    new NextRequest(`http://jarvis.test${path}${query}`, {
      method,
      headers: {
        ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}),
        ...(csrf ? { "x-jarvis-csrf": "1" } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}

describe("validation default per area", () => {
  it("is optional for Miscellaneous and Home, required elsewhere, and an explicit setting wins", () => {
    expect(areaValidationDefault({ title: "Miscellaneous", systemKey: "misc" })).toBe("optional");
    expect(areaValidationDefault({ title: " home " })).toBe("optional");
    expect(areaValidationDefault({ title: "Household", systemKey: "home" })).toBe("optional");
    expect(areaValidationDefault({ title: "Momentum Bets" })).toBe("required");
    expect(areaValidationDefault({ title: "Home", validationDefault: "required" })).toBe("required");
    expect(areaValidationDefault({ title: "Momentum Bets", validationDefault: "optional" })).toBe("optional");
    expect(areaValidationDefault(null)).toBe("required");
  });

  it("new packets take the area default unless the form overrides it", () => {
    const u = me();
    const home = store.createItem(u, { kind: "area", title: "Home" }, cid);
    const hvac = store.createItem(u, { kind: "thread", title: "HVAC filter", parentId: home.id }, cid);
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    const loose = store.createItem(u, { kind: "thread", title: "Loose end" }, cid); // → Miscellaneous

    expect(store.getDetail(owner, hvac.id).validationDefault).toMatchObject({ value: "optional", explicit: false, areaTitle: "Home" });
    expect(store.getDetail(owner, v5.id).validationDefault).toMatchObject({ value: "required", areaTitle: "Momentum Bets" });
    expect(store.getDetail(owner, loose.id).validationDefault).toMatchObject({ value: "optional", areaTitle: "Miscellaneous" });

    const p = (o: object = {}) => packetSchema.parse({ objective: "Do it", nextAction: "Start", ...o });
    expect(store.createPacket(u, hvac.id, p(), cid)).toMatchObject({
      validationRequired: false,
      noValidationReason: "Validation is optional in Home (area default)",
    });
    expect(store.createPacket(u, v5.id, p(), cid)).toMatchObject({ validationRequired: true, noValidationReason: null });
    expect(store.createPacket(u, loose.id, p({ validationRequired: true }), cid)).toMatchObject({ validationRequired: true });
    expect(store.createPacket(u, v5.id, p({ validationRequired: false, noValidationReason: "Docs only" }), cid)).toMatchObject({
      validationRequired: false,
      noValidationReason: "Docs only",
    });
    // An explicit false still needs a reason (the form prefills one).
    expect(() => packetSchema.parse({ objective: "x", nextAction: "y", validationRequired: false })).toThrow();

    // Editable on the area; the item detail follows.
    store.updateItem(u, home.id, { validationDefault: "required" }, cid);
    expect(store.getDetail(owner, hvac.id).validationDefault).toMatchObject({ value: "required", explicit: true });
    expect(store.createPacket(u, hvac.id, p(), cid).validationRequired).toBe(true);
    store.updateItem(u, home.id, { validationDefault: null }, cid);
    expect(store.getDetail(owner, hvac.id).validationDefault).toMatchObject({ value: "optional", explicit: false });
    expect(() => store.updateItem(u, hvac.id, { validationDefault: "optional" }, cid)).toThrow(/area setting/);
  });

  it("is validated and owner-scoped at the API", async () => {
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const v5 = store.createItem(u, { kind: "thread", title: "V5", parentId: mb.id }, cid);
    expect((await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: mb.id }, body: { validationDefault: "maybe" } })).status).toBe(400);
    expect((await call(itemRoute.PATCH as H, { method: "PATCH", params: { id: mb.id }, body: { validationDefault: "optional" } })).status).toBe(200);
    expect((await call(itemRoute.PATCH as H, { user: other, method: "PATCH", params: { id: mb.id }, body: { validationDefault: "required" } })).status).toBe(
      404,
    );
    const res = await call(packetsRoute.POST as H, { method: "POST", params: { id: v5.id }, body: { objective: "x", nextAction: "y" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { packet: { validationRequired: boolean } }).packet.validationRequired).toBe(false);
  });
});

describe("auto-settle: never", () => {
  it("keeps legacy auto-settled rows readable", () => {
    const u = me();
    const mb = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
    const old = store.createItem(u, { kind: "thread", title: "Old", parentId: mb.id }, cid);
    getDb()
      .update(schema.workItems)
      .set({ status: "settled", settledKind: "auto", settledReason: "PR #3 merged; no validation required" })
      .where(eq(schema.workItems.id, old.id))
      .run();
    expect(store.getDetail(owner, old.id).item).toMatchObject({ status: "settled", settledKind: "auto" });
    expect(kid).toBeTruthy();
  });
});
