import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as importRoute from "@/app/api/workflows/import/route";
import * as itemRoute from "@/app/api/workflows/[id]/route";
import * as formRoute from "@/app/api/workflows/form/route";
import * as runsRoute from "@/app/api/workflows/runs/route";
import * as runRoute from "@/app/api/workflows/runs/[runId]/route";
import * as undoRoute from "@/app/api/workflows/runs/[runId]/undo/route";
import * as endRoute from "@/app/api/workflows/runs/[runId]/end/route";
import * as proposalsRoute from "@/app/api/workflows/runs/[runId]/proposals/route";
import * as placesRoute from "@/app/api/workflows/places/route";
import * as placeRoute from "@/app/api/workflows/places/[placeId]/route";
import * as rememberedRoute from "@/app/api/workflows/[id]/remembered/route";
import teaching from "@/lib/workflows/fixtures/teaching-notes.json";

let owner: string;
let other: string;

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

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = (await r.json()) as T;
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function activeTeaching() {
  const { results } = await json<{ results: { id: string }[] }>(call(importRoute.POST, { body: { data: teaching } }));
  await json(call(itemRoute.PATCH, { method: "PATCH", body: { status: "active" }, params: { id: results[0].id } }));
  return results[0].id;
}

type Run = {
  id: string;
  title: string;
  status: string;
  capture: Record<string, unknown>;
  log: { id: string; by: string; undone: boolean }[];
  proposals: unknown[];
};

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
});

describe("workflow runs API", () => {
  it("start form → run → agent proposal → undo → end, remembering values", async () => {
    const wf = await activeTeaching();
    const form = await json<{ values: Record<string, { value: unknown; provenance: string }>; form: { submit: string } }>(
      call(formRoute.POST, { body: { command: "/teaching Jake Fry John 15" } }),
    );
    expect(form.form.submit).toBe("Start session");
    expect(form.values.speaker).toMatchObject({ value: { name: "Jake Fry" }, provenance: "palette" });
    expect(form.values.place.provenance).toBe("workflowPlace");
    const values = Object.fromEntries(Object.entries(form.values).map(([k, v]) => [k, v.value]));
    const started = await json<{ run: Run; input: string; context: string }>(call(runsRoute.POST, { body: { workflowId: wf, values } }));
    expect(started.input).toBe("Session: Heartland Sun Prairie – Jake Fry");
    expect(started.context).toContain("jarvis-capture@1");
    const id = started.run.id;

    const text =
      'Got it.\n```jarvis-capture\n[{"op":"add","path":"/quotes/-","value":{"text":"Remain in me","who":"Jake Fry"}},{"op":"add","path":"/evil/-","value":1}]\n```';
    const p = await json<{ run: Run; dropped: number; applied: string[] }>(
      call(runRoute.PATCH, { method: "PATCH", body: { by: "agent", text }, params: { runId: id } }),
    );
    expect(p.dropped).toBe(1);
    expect(p.run.capture.quotes).toEqual([{ text: "Remain in me", who: "Jake Fry" }]);

    const u = await json<{ run: Run; undone: string[] }>(call(undoRoute.POST, { body: {}, params: { runId: id } }));
    expect(u.undone).toEqual(p.applied);
    expect(u.run.capture.quotes).toEqual([]);

    // AI-proposed form values wait for a tap
    const prop = '```jarvis-capture\n{"propose":true,"ops":[{"op":"replace","path":"/session/series","value":"Abide"}]}\n```';
    const pr = await json<{ run: Run; proposed: number }>(call(runRoute.PATCH, { method: "PATCH", body: { by: "agent", text: prop }, params: { runId: id } }));
    expect(pr.proposed).toBe(1);
    expect((pr.run.capture.session as Record<string, unknown>).series).toBeUndefined();
    const acc = await json<{ run: Run }>(call(proposalsRoute.POST, { body: { accept: [0] }, params: { runId: id } }));
    expect((acc.run.capture.session as Record<string, unknown>).series).toBe("Abide");
    expect(acc.run.proposals).toEqual([]);

    const ended = await json<Run>(call(endRoute.POST, { params: { runId: id } }));
    expect(ended.status).toBe("ended");
    await json(call(runRoute.PATCH, { method: "PATCH", body: { by: "user", ops: [] }, params: { runId: id } }), 409);

    // D11: speaker remembered for next time; forgettable per field
    const again = await json<{ values: Record<string, { value: unknown; provenance: string }> }>(call(formRoute.POST, { body: { workflowId: wf } }));
    expect(again.values.speaker).toMatchObject({ value: { name: "Jake Fry" }, provenance: "last" });
    await json(call(rememberedRoute.DELETE, { method: "DELETE", params: { id: wf }, url: "http://jarvis.test/api/workflows/x/remembered?field=speaker" }));
    const after = await json<{ values: Record<string, { provenance: string }> }>(call(formRoute.POST, { body: { workflowId: wf } }));
    expect(after.values.speaker.provenance).toBe("none");
    const actions = getDb()
      .select()
      .from(schema.auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["workflow.run.start", "workflow.run.capture", "workflow.run.undo", "workflow.run.end", "workflow.remembered.forget"]),
    );
  });

  it("rejects an invalid start form server-side and keeps runs per owner", async () => {
    const wf = await activeTeaching();
    await json(call(runsRoute.POST, { body: { workflowId: wf, values: { speaker: null } } }), 422);
    const form = await json<{ values: Record<string, { value: unknown }> }>(call(formRoute.POST, { body: { workflowId: wf } }));
    const values = { ...Object.fromEntries(Object.entries(form.values).map(([k, v]) => [k, v.value])), speaker: "Ann" };
    const { run } = await json<{ run: Run }>(call(runsRoute.POST, { body: { workflowId: wf, values } }));
    await json(call(runRoute.GET, { method: "GET", params: { runId: run.id }, as: other }), 404);
  });

  it("saved places: save, list, forget; never logs coordinates", async () => {
    const saved = await json<{ id: string; coordinatesStored: boolean }>(
      call(placesRoute.POST, { body: { label: "Heartland Sun Prairie", lat: 43.18, lng: -89.21 } }),
    );
    expect(saved.coordinatesStored).toBe(true);
    const list = await json<{ places: { label: string; lat: number | null }[] }>(call(placesRoute.GET, { method: "GET" }));
    expect(list.places).toEqual([expect.objectContaining({ label: "Heartland Sun Prairie", lat: 43.18 })]);
    expect(JSON.stringify(getDb().select().from(schema.auditLog).all())).not.toContain("43.18");
    await json(call(placesRoute.POST, { body: { label: "https://evil.example" } }), 400);
    await json(call(placeRoute.DELETE, { method: "DELETE", params: { placeId: saved.id }, as: other }), 404);
    await json(call(placeRoute.DELETE, { method: "DELETE", params: { placeId: saved.id } }));
    expect((await json<{ places: unknown[] }>(call(placesRoute.GET, { method: "GET" }))).places).toEqual([]);
  });
});
