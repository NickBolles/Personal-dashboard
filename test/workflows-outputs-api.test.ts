import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import * as importRoute from "@/app/api/workflows/import/route";
import * as itemRoute from "@/app/api/workflows/[id]/route";
import * as formRoute from "@/app/api/workflows/form/route";
import * as runsRoute from "@/app/api/workflows/runs/route";
import * as runRoute from "@/app/api/workflows/runs/[runId]/route";
import * as endRoute from "@/app/api/workflows/runs/[runId]/end/route";
import * as summaryRoute from "@/app/api/workflows/runs/[runId]/summary/route";
import * as exportRoute from "@/app/api/workflows/runs/[runId]/export/route";
import * as promoteRoute from "@/app/api/workflows/runs/[runId]/promote/route";
import * as sessionRoute from "@/app/api/workflows/runs/[runId]/session/route";
import * as historyRoute from "@/app/api/workflows/[id]/history/route";
import * as reminderRoute from "@/app/api/workflows/[id]/reminder/route";
import * as workItemsRoute from "@/app/api/work/items/route";
import { sendDueReminders } from "@/server/workflows/outputs";
import { getPreferences } from "@/server/settings";
import { localTimeToInstant } from "@/lib/time";
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

type Run = {
  id: string;
  status: string;
  capture: Record<string, unknown>;
  summary: string | null;
  summaryState: string;
  promoted: { itemId: string; title: string }[];
};

async function startTeaching() {
  const { results } = await json<{ results: { id: string }[] }>(call(importRoute.POST, { body: { data: teaching } }));
  const wf = results[0].id;
  await json(call(itemRoute.PATCH, { method: "PATCH", body: { status: "active" }, params: { id: wf } }));
  const form = await json<{ values: Record<string, { value: unknown }> }>(call(formRoute.POST, { body: { command: "/teaching Jake Fry John 15" } }));
  const values = Object.fromEntries(Object.entries(form.values).map(([k, v]) => [k, v.value]));
  const started = await json<{ run: Run }>(call(runsRoute.POST, { body: { workflowId: wf, values } }));
  return { wf, id: started.run.id };
}

const addActions = (id: string, texts: string[]) =>
  json<{ run: Run }>(
    call(runRoute.PATCH, {
      method: "PATCH",
      body: { by: "user", ops: texts.map((t) => ({ op: "add", path: "/actions/-", value: { text: t } })), source: "quickAdd" },
      params: { runId: id },
    }),
  );

beforeEach(() => {
  __setTestDatabase();
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
});

describe("workflow outputs API (W4)", () => {
  it("edit session replaces scalars only; end form files then ends; summary accept; markdown export", async () => {
    const { id } = await startTeaching();
    const before = getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get()!;
    const scriptureBefore = JSON.parse(before.captureJson).scripture;
    const e = await json<{ run: Run; applied: string[] }>(
      call(sessionRoute.PATCH, { method: "PATCH", body: { values: { speaker: "Ann Lyle", ref: "Ps 23" } }, params: { runId: id } }),
    );
    expect(e.applied).toHaveLength(1);
    expect((e.run.capture.session as Record<string, unknown>).speaker).toEqual({ name: "Ann Lyle" });
    expect(e.run.capture.scripture).toEqual(scriptureBefore); // list binds are never touched by Edit session

    const ended = await json<Run>(call(endRoute.POST, { body: { values: { apply: "Call my brother" } }, params: { runId: id } }));
    expect(ended.status).toBe("ended");
    expect(ended.capture.reflections).toEqual(["Call my brother"]);

    const acc = await json<Run>(call(summaryRoute.PUT, { method: "PUT", body: { summary: "Abide in the vine." }, params: { runId: id } }));
    expect(acc.summaryState).toBe("accepted");
    const md = await json<{ fileName: string; markdown: string }>(call(exportRoute.GET, { method: "GET", params: { runId: id } }));
    expect(md.fileName).toMatch(/^teaching-\d{4}-\d{2}-\d{2}\.md$/);
    expect(md.markdown).toContain("## Summary\n\nAbide in the vine.");
    expect(md.markdown).toContain("- **Speaker:** Ann Lyle");
    expect(md.markdown).toContain("Call my brother");
    // no outbound writes from ending
    expect(
      getDb()
        .select()
        .from(schema.workItems)
        .all()
        .filter((i) => i.kind === "thread"),
    ).toHaveLength(0);
  });

  it("creates work items only for the exact confirmed titles", async () => {
    const { id } = await startTeaching();
    await addActions(id, ["Call Sam", "Read John 16"]);
    const area = await json<{ item: { id: string } }>(
      call(workItemsRoute.POST, { body: { kind: "area", title: "Faith", parentId: null }, url: "http://jarvis.test/api/work/items" }),
      201,
    ).catch(async () =>
      json<{ item: { id: string } }>(
        call(workItemsRoute.POST, { body: { kind: "area", title: "Faith", parentId: null }, url: "http://jarvis.test/api/work/items" }),
      ),
    );
    const parentId = area.item.id;
    await json(call(promoteRoute.POST, { body: { indices: [1], parentId, titles: ["Something else"] }, params: { runId: id } }), 409);
    const r = await json<{ run: Run; created: { itemId: string; title: string }[] }>(
      call(promoteRoute.POST, { body: { indices: [1, 0], parentId, due: "2026-11-08", titles: ["Read John 16", "Call Sam"] }, params: { runId: id } }),
    );
    expect(r.created.map((c) => c.title)).toEqual(["Read John 16", "Call Sam"]);
    expect(r.run.promoted).toHaveLength(2);
    const items = getDb().select().from(schema.workItems).where(eq(schema.workItems.parentId, parentId)).all();
    expect(items.map((i) => i.title).sort()).toEqual(["Call Sam", "Read John 16"]);
    expect(items.every((i) => i.status !== "settled")).toBe(true);
    // another person can't reach the run
    await json(call(promoteRoute.POST, { as: other, body: { indices: [0], parentId, titles: ["Call Sam"] }, params: { runId: id } }), 404);
  });

  it("#145 a second confirm of the same actions creates nothing (idempotent per run + action)", async () => {
    const { id } = await startTeaching();
    await addActions(id, ["Call Sam", "Read John 16"]);
    const area = await json<{ item: { id: string } }>(
      call(workItemsRoute.POST, { body: { kind: "area", title: "Faith", parentId: null }, url: "http://jarvis.test/api/work/items" }),
    );
    const parentId = area.item.id;
    const body = { indices: [0], parentId, titles: ["Call Sam"] };
    const first = await json<{ created: unknown[]; already: unknown[] }>(call(promoteRoute.POST, { body, params: { runId: id } }));
    expect(first.created).toHaveLength(1);
    const again = await json<{ run: Run; created: unknown[]; already: { title: string }[] }>(call(promoteRoute.POST, { body, params: { runId: id } }));
    expect(again.created).toHaveLength(0);
    expect(again.already.map((a) => a.title)).toEqual(["Call Sam"]);
    expect(again.run.promoted).toHaveLength(1);
    // a mixed confirm creates only the new one
    const mixed = await json<{ created: { title: string }[]; already: unknown[] }>(
      call(promoteRoute.POST, { body: { indices: [0, 1], parentId, titles: ["Call Sam", "Read John 16"] }, params: { runId: id } }),
    );
    expect(mixed.created.map((c) => c.title)).toEqual(["Read John 16"]);
    expect(mixed.already).toHaveLength(1);
    const items = getDb().select().from(schema.workItems).where(eq(schema.workItems.parentId, parentId)).all();
    expect(items.map((i) => i.title).sort()).toEqual(["Call Sam", "Read John 16"]);
  });

  it("#147/#148 end form and Edit session keep number/toggle/tags values; invalid answers keep the run live", async () => {
    const typed = {
      ...teaching,
      slug: "teachtyped",
      name: "Typed notes",
      triggers: [{ kind: "palette", command: "/teachtyped" }],
      capture: {
        ...teaching.capture,
        session: { ...teaching.capture.session, fields: { ...teaching.capture.session.fields, rating: "number?", again: "bool?" } },
      },
      forms: {
        ...teaching.forms,
        mid: {
          ...teaching.forms.mid,
          fields: [...teaching.forms.mid.fields, "tags", { id: "rating", bind: "session.rating", type: "number", label: "Rating", min: 1, max: 5 }],
        },
        end: {
          ...teaching.forms.end,
          fields: [...teaching.forms.end.fields, "rating", { id: "again", bind: "session.again", type: "toggle", label: "Come back next week" }],
        },
      },
    };
    const { results } = await json<{ results: { id: string; ok: boolean }[] }>(call(importRoute.POST, { body: { data: typed } }));
    expect(results[0].ok, JSON.stringify(results)).toBe(true);
    const wf = results[0].id;
    await json(call(itemRoute.PATCH, { method: "PATCH", body: { status: "active" }, params: { id: wf } }));
    const form = await json<{ values: Record<string, { value: unknown }> }>(call(formRoute.POST, { body: { command: "/teachtyped Jake Fry John 15" } }));
    const values = Object.fromEntries(Object.entries(form.values).map(([k, v]) => [k, v.value]));
    const id = (await json<{ run: Run }>(call(runsRoute.POST, { body: { workflowId: wf, values } }))).run.id;

    // Edit session: typed values (and string forms from older clients) are filed with their type
    const e = await json<{ run: Run; applied: string[] }>(
      call(sessionRoute.PATCH, { method: "PATCH", body: { values: { tags: ["vine", "fruit"], rating: "4" } }, params: { runId: id } }),
    );
    expect(e.applied).toHaveLength(2);
    expect(e.run.capture.session).toMatchObject({ tags: ["vine", "fruit"], rating: 4 });
    // a value that can't be filed is rejected, never reported as "No changes"
    await json(call(sessionRoute.PATCH, { method: "PATCH", body: { values: { rating: "lots" } }, params: { runId: id } }), 422);

    // End form: invalid number blocks ending (run stays live, nothing filed)
    await json(call(endRoute.POST, { body: { values: { apply: "Call my brother", rating: "lots" } }, params: { runId: id } }), 422);
    let row = getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get()!;
    expect(row.status).toBe("live");
    expect(JSON.parse(row.captureJson).reflections).toEqual([]);

    const ended = await json<Run>(call(endRoute.POST, { body: { values: { apply: "Call my brother", rating: 5, again: true } }, params: { runId: id } }));
    expect(ended.status).toBe("ended");
    expect(ended.capture.reflections).toEqual(["Call my brother"]);
    expect(ended.capture.session).toMatchObject({ rating: 5, again: true, tags: ["vine", "fruit"] });
    row = getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get()!;
    expect(row.status).toBe("ended");
  });

  it("history + stats + filters, and the reminder only notifies (never starts a run)", async () => {
    const { wf } = await startTeaching();
    const h = await json<{ rows: { speaker: string; books: string[] }[]; stats: { total: number; perMonth: unknown[]; topSpeakers: { label: string }[] } }>(
      call(historyRoute.GET, { method: "GET", params: { id: wf }, url: "http://jarvis.test/api/workflows/x/history?speaker=Jake%20Fry" }),
    );
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].books).toEqual(["John"]);
    expect(h.stats.perMonth).toHaveLength(12);
    expect(h.stats.topSpeakers[0].label).toBe("Jake Fry");
    const none = await json<{ rows: unknown[] }>(
      call(historyRoute.GET, { method: "GET", params: { id: wf }, url: "http://jarvis.test/api/workflows/x/history?speaker=Nobody" }),
    );
    expect(none.rows).toHaveLength(0);

    const off = await json<{ enabled: boolean; day: number; time: string }>(call(reminderRoute.GET, { method: "GET", params: { id: wf } }));
    expect(off.enabled).toBe(false);
    const on = await json<{ enabled: boolean; time: string }>(
      call(reminderRoute.PUT, { method: "PUT", body: { enabled: true, day: 0, time: "09:45" }, params: { id: wf } }),
    );
    expect(on).toMatchObject({ enabled: true, time: "09:45" });
    const runsBefore = getDb().select().from(schema.workflowRuns).all().length;
    // Sunday 2026-11-08 in the owner's timezone
    const tz = getPreferences().timezone;
    expect(sendDueReminders(localTimeToInstant("2026-11-08", "09:40", tz))).toBe(0); // never early
    expect(sendDueReminders(localTimeToInstant("2026-11-08", "09:50", tz))).toBe(1);
    expect(sendDueReminders(localTimeToInstant("2026-11-08", "09:55", tz))).toBe(0); // once per day
    const n = getDb().select().from(schema.notifications).all();
    expect(n.map((x) => x.deepLink)).toEqual(["/workflows?start=teaching"]);
    expect(getDb().select().from(schema.workflowRuns).all().length).toBe(runsBefore);
  });
});
