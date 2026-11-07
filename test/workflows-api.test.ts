import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as listRoute from "@/app/api/workflows/route";
import * as itemRoute from "@/app/api/workflows/[id]/route";
import * as importRoute from "@/app/api/workflows/import/route";
import * as exportRoute from "@/app/api/workflows/export/route";
import * as startRoute from "@/app/api/workflows/start/route";
import teaching from "@/lib/workflows/fixtures/teaching-notes.json";
import * as store from "@/server/work/store";
import { mapPaletteArgs } from "@/lib/workflows/palette-args";
import type { WorkflowDefinition } from "@/lib/workflows/definition";

let owner: string;
let other: string;
let kid: string;

function call(handler: unknown, opts: { method?: string; body?: unknown; as?: string; params?: Record<string, string>; url?: string } = {}) {
  const { method = "POST", body, as = owner, params = {}, url = "http://jarvis.test/api/workflows" } = opts;
  return (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new NextRequest(url, {
      method,
      headers: { cookie: `jarvis_session=${createSession(as).token}`, "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  kid = createPerson({ name: "Kiddo", username: "kiddo", role: "kid", passcode: "synthetic-pass" }, owner).id;
});

async function importTeaching(as = owner) {
  const res = await call(importRoute.POST, { body: { data: teaching }, as });
  expect(res.status).toBe(200);
  const { results } = (await res.json()) as { results: { ok: boolean; id: string; duplicate: boolean }[] };
  return results[0];
}

describe("workflows API", () => {
  it("imports as a draft, lists built-ins, and is audited", async () => {
    const r = await importTeaching();
    expect(r.ok).toBe(true);
    const list = (await (await call(listRoute.GET, { method: "GET" })).json()) as {
      workflows: { slug: string; status: string }[];
      builtIns: { kind: string }[];
    };
    expect(list.workflows).toEqual([expect.objectContaining({ slug: "teaching", status: "draft" })]);
    expect(list.builtIns.map((b) => b.kind)).toEqual(["brief", "week", "pr"]);
    const audits = getDb()
      .select()
      .from(schema.auditLog)
      .all()
      .map((a) => a.action);
    expect(audits).toContain("workflow.import");
  });

  it("dedupes an identical re-import and rejects invalid definitions with issues", async () => {
    await importTeaching();
    expect((await importTeaching()).duplicate).toBe(true);
    const bad = await call(importRoute.POST, { body: { data: { ...teaching, instructions: "", routing: { area: "Finance", modelTier: "fast" } } } });
    const { results } = (await bad.json()) as { results: { ok: boolean; issues: { code: string }[] }[] };
    expect(results[0].ok).toBe(false);
    expect(results[0].issues[0].code).toBe("invalid");
  });

  it("export → import round trip keeps the definition", async () => {
    const r = await importTeaching();
    const exp = (await (await call(exportRoute.GET, { method: "GET", url: `http://jarvis.test/api/workflows/export?id=${r.id}` })).json()) as {
      workflows: unknown[];
    };
    expect(exp.workflows).toHaveLength(1);
    expect(exp.workflows[0]).toEqual(teaching);
    // the other person imports the export into their own space
    const res = await call(importRoute.POST, { body: { data: exp }, as: other });
    const { results } = (await res.json()) as { results: { ok: boolean; duplicate: boolean }[] };
    expect(results[0]).toEqual(expect.objectContaining({ ok: true, duplicate: false }));
  });

  it("versions are immutable and the slug is locked", async () => {
    const r = await importTeaching();
    const v2 = await call(itemRoute.PUT, { method: "PUT", params: { id: r.id }, body: { definition: { ...teaching, description: "v2" }, changeNote: "desc" } });
    expect(v2.status).toBe(200);
    const body = (await v2.json()) as { workflow: { currentVersion: number }; versions: { version: number }[] };
    expect(body.workflow.currentVersion).toBe(2);
    expect(body.versions.map((v) => v.version)).toEqual([2, 1]);
    const slug = await call(itemRoute.PUT, { method: "PUT", params: { id: r.id }, body: { definition: { ...teaching, slug: "notes", triggers: [] } } });
    expect(slug.status).toBe(422);
  });

  it("permissions: others can't see or change it; kids have no access", async () => {
    const r = await importTeaching();
    expect((await call(itemRoute.GET, { method: "GET", params: { id: r.id }, as: other })).status).toBe(404);
    expect((await call(itemRoute.PATCH, { method: "PATCH", params: { id: r.id }, body: { status: "active" }, as: other })).status).toBe(404);
    expect((await call(listRoute.GET, { method: "GET", as: kid })).status).toBe(403);
    expect((await call(importRoute.POST, { body: { data: teaching }, as: kid })).status).toBe(403);
  });

  it("palette start: drafts refuse, active maps args and carries instructions", async () => {
    const r = await importTeaching();
    const draft = await call(startRoute.POST, { body: { command: "/teaching Jake Fry" } });
    expect(draft.status).toBe(409);
    expect((await call(itemRoute.PATCH, { method: "PATCH", params: { id: r.id }, body: { status: "active" } })).status).toBe(200);
    const res = await call(startRoute.POST, { body: { command: "/teaching Jake Fry" } });
    expect(res.status).toBe(200);
    const s = (await res.json()) as { input: string; context: string; prefill: Record<string, unknown> };
    expect(s.prefill.speaker).toEqual({ name: "Jake Fry" });
    expect(s.input).toBe("Teaching notes — Speaker: Jake Fry");
    expect(s.context).toContain("Don't add outside commentary");
    expect((await call(startRoute.POST, { body: { command: "/nope" } })).status).toBe(404);
  });

  it("picks up the routing area when it is created after import (#123)", async () => {
    const r = (await (await call(importRoute.POST, { body: { data: teaching } })).json()) as { results: { id: string; areaFound: boolean }[] };
    expect(r.results[0].areaFound).toBe(false);
    const id = r.results[0].id;
    const area = store.createItem(resolveUser(new Headers(), createSession(owner).token)!, { kind: "area", title: "Faith" }, "cid-test");
    const act = (await (await call(itemRoute.PATCH, { method: "PATCH", params: { id }, body: { status: "active" } })).json()) as {
      workflow: { areaId: string | null };
    };
    expect(act.workflow.areaId).toBe(area.id);
    const s = (await (await call(startRoute.POST, { body: { command: "/teaching" } })).json()) as { areaId: string | null };
    expect(s.areaId).toBe(area.id);
  });

  it("keeps unmatched palette words in the first message and reads single-token refs (#122, #124)", async () => {
    const r = await importTeaching();
    await call(itemRoute.PATCH, { method: "PATCH", params: { id: r.id }, body: { status: "active" } });
    const m = mapPaletteArgs(teaching as unknown as WorkflowDefinition, "Jake Fry jn15:5", { now: new Date(), timezone: "America/Chicago" });
    expect(m.values.ref).toMatchObject({ book: "John", chapter: 15, verseStart: 5 });
    const res = await call(startRoute.POST, { body: { command: "/teaching jn15:5" } });
    const s = (await res.json()) as { input: string; prefill: Record<string, unknown> };
    expect(s.prefill.ref).toMatchObject({ book: "John", chapter: 15 });
    // a workflow whose palette args take only the reference keeps the other words
    const refOnly = {
      ...teaching,
      slug: "verse",
      name: "Verse",
      triggers: [{ kind: "palette", command: "/verse" }],
      start: { ...(teaching as { start?: object }).start, args: ["ref"] },
    };
    const v = (await (await call(importRoute.POST, { body: { data: refOnly } })).json()) as { results: { ok: boolean; id: string }[] };
    expect(v.results[0].ok).toBe(true);
    await call(itemRoute.PATCH, { method: "PATCH", params: { id: v.results[0].id }, body: { status: "active" } });
    const u = (await (await call(startRoute.POST, { body: { command: "/verse John 15 bring the kids" } })).json()) as { input: string; unmatched: string };
    expect(u.unmatched).toBe("bring the kids");
    expect(u.input).toContain("bring the kids");
  });
});
