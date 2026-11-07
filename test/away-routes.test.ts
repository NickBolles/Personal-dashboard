import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { __setTestDatabase, getDb, getSqlite, schema } from "@/server/db";
import { createSession, userById, type CurrentUser } from "@/server/auth";
import { setSetting, updatePreferences } from "@/server/settings";
import { createItem, updateItem } from "@/server/work/store";
import * as root from "@/app/api/agents/schedules/route";
import * as item from "@/app/api/agents/schedules/[id]/route";
import * as run from "@/app/api/agents/schedules/[id]/run/route";
import * as exports from "@/app/api/agents/schedules/export/route";
import * as imports from "@/app/api/agents/schedules/import/route";
import * as away from "@/app/api/agents/away/route";
import * as dismiss from "@/app/api/agents/away/dismiss/route";
import { MAX_JOBS } from "@/lib/away";
import { createJob, jobRows } from "@/server/agents/schedules";
import { defaultDeps } from "@/server/agents/scheduler";

vi.mock("@/server/assistant", () => ({
  createSession: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  getSessionDetail: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
  sessionAccess: vi.fn(),
  getSessionSummary: vi.fn(),
  listLocalConversations: vi.fn(),
  visibleSessions: vi.fn(),
  reconcileRun: vi.fn(),
}));

let owner: CurrentUser;
let areaId: string;
const input = () => ({
  title: "Synthetic brief",
  kind: "brief",
  areaId,
  prompt: "SCHEDULED_SILENT",
  enabled: true,
  overnight: true,
  schedule: { freq: "daily", time: "05:30", days: [] },
});
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(handler: unknown, method = "GET", body?: unknown, id = "", userId = "owner") {
  return (handler as Handler)(
    new NextRequest("http://localhost/api/agents/schedules", {
      method,
      headers: { "content-type": "application/json", "x-jarvis-csrf": "1", cookie: `jarvis_session=${createSession(userId).token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ id }) },
  );
}
beforeAll(() => {
  __setTestDatabase();
});
afterEach(() => {
  getSqlite().exec("ROLLBACK TO away_routes; RELEASE away_routes");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  getSqlite().exec("SAVEPOINT away_routes");
  getDb()
    .insert(schema.users)
    .values([
      { id: "owner", name: "Owner", role: "admin" },
      { id: "admin2", name: "Other admin", role: "admin" },
      { id: "adult", name: "Other", role: "adult" },
    ])
    .run();
  setSetting("owner_user_id", "owner");
  owner = userById("owner")!;
  updatePreferences({ timezone: "America/Chicago" });
  areaId = createItem(owner, { kind: "area", title: "Workshop" }, "test").id;
  updateItem(owner, areaId, { settings: { agentMode: "devchief" } }, "test");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in route tests");
    }),
  );
});
it("CRUD, seeds disabled, validates and audits mutations", async () => {
  const listed = await (await call(root.GET)).json();
  expect(listed.jobs).toHaveLength(2);
  expect(listed.jobs.every((j: { enabled: boolean }) => !j.enabled)).toBe(true);
  expect(listed).toMatchObject({ tz: "America/Chicago", caps: { maxJobs: MAX_JOBS, runsToday: 0 } });
  const created = await call(root.POST, "POST", input());
  expect(created.status).toBe(201);
  const { job } = await created.json();
  expect(job.enabled).toBe(false);
  expect((await call(item.PATCH, "PATCH", { enabled: true, title: "Updated" }, job.id)).status).toBe(200);
  const out = await (await call(root.GET)).json();
  expect(out.jobs.find((j: { id: string }) => j.id === job.id)).toMatchObject({ enabled: true, title: "Updated" });
  expect((await call(item.DELETE, "DELETE", undefined, job.id)).status).toBe(200);
  expect((await call(item.PATCH, "PATCH", { enabled: false }, job.id)).status).toBe(404);
  expect((await call(root.POST, "POST", { ...input(), title: "" })).status).toBe(400);
  expect(
    getDb()
      .select()
      .from(schema.auditLog)
      .all()
      .some((a) => a.action === "agents.schedules.update"),
  ).toBe(true);
});
it("import is disabled, dedupes title+area and roundtrips export", async () => {
  const initial = {
    version: 1,
    exportedAt: "2026-11-07T00:00:00Z",
    jobs: [
      { title: "Imported", areaTitle: "workshop", kind: "custom", prompt: "Check", schedule: { freq: "daily", time: "08:00", days: [] }, overnight: false },
    ],
  };
  const imported = await call(imports.POST, "POST", initial);
  expect(await imported.json()).toEqual({ created: 1, skipped: [] });
  expect(jobRows(owner)[0].enabled).toBe(false);
  expect((await (await call(imports.POST, "POST", initial)).json()).skipped[0].reason).toBe("duplicate");
  const exported = await call(exports.GET);
  expect(exported.headers.get("content-disposition")).toContain("jarvis-schedules.json");
  const roundtrip = await exported.json();
  expect(roundtrip.jobs[0]).toMatchObject({ title: "Imported", areaTitle: "Workshop" });
  expect(await (await call(imports.POST, "POST", roundtrip)).json()).toEqual({ created: 0, skipped: [{ title: "Imported", reason: "duplicate" }] });
});
it("missing areas create unassigned jobs; Finance/excluded matches never bind to AI", async () => {
  createItem(owner, { kind: "area", title: "Finance" }, "test");
  const jobs = ["Finance", "Not found"].map((areaTitle) => ({
    title: areaTitle,
    areaTitle,
    kind: "brief",
    prompt: "Check",
    schedule: { freq: "daily", time: "08:00", days: [] },
  }));
  const out = await (await call(imports.POST, "POST", { version: 1, exportedAt: "now", jobs })).json();
  expect(out).toEqual({ created: 2, skipped: [{ title: "Not found", reason: "area not found" }] });
  expect(jobRows(owner).every((j) => !j.enabled && j.areaId === null)).toBe(true);
  const list = await (await call(root.GET)).json();
  expect(list.areas.find((a: { title: string }) => a.title === "Finance").autonomy).toBe("off");
});
it("cap is 409 and import skips over-cap entries", async () => {
  for (let i = 0; i < MAX_JOBS; i++)
    createJob(owner, { ...input(), kind: "brief", schedule: { freq: "daily", time: "08:00", days: [] }, title: `Job ${i}` }, "test");
  const capped = await call(root.POST, "POST", input());
  expect(capped.status).toBe(409);
  expect((await capped.json()).code).toBe("too_many_jobs");
  const result = await (
    await call(imports.POST, "POST", { version: 1, exportedAt: "now", jobs: [{ ...input(), areaId: undefined, areaTitle: "Workshop" }] })
  ).json();
  expect(result).toEqual({ created: 0, skipped: [{ title: "Synthetic brief", reason: "too_many_jobs" }] });
});
it("run-now requires literal confirm, Finance returns ai_off and missing area returns not_ready", async () => {
  const { job } = await (await call(root.POST, "POST", input())).json();
  for (const body of [{}, { confirm: false }, { confirm: "true" }]) expect((await call(run.POST, "POST", body, job.id)).status).toBe(400);
  const finance = createItem(owner, { kind: "area", title: "Finance" }, "test");
  await call(item.PATCH, "PATCH", { areaId: finance.id }, job.id);
  const refused = await call(run.POST, "POST", { confirm: true }, job.id);
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe("ai_off");
  await call(item.PATCH, "PATCH", { areaId: null }, job.id);
  expect((await (await call(run.POST, "POST", { confirm: true }, job.id)).json()).code).toBe("not_ready");
});
it("strictly decodes and validates route segments", async () => {
  for (const id of ["../x", "%2F", "bad%20id", "%00", "%E0%A4%A", "x".repeat(65)]) {
    expect((await call(item.PATCH, "PATCH", { enabled: false }, id)).status).toBe(400);
    expect((await call(item.DELETE, "DELETE", undefined, id)).status).toBe(400);
    expect((await call(run.POST, "POST", { confirm: true }, id)).status).toBe(400);
  }
});
it("confirmed run-now returns 202 with the scheduled run and agent-panel identity", async () => {
  vi.spyOn(defaultDeps, "createSession").mockResolvedValue({ id: "mock-route-session", title: "Scheduled brief", pinned: false, archived: false });
  vi.spyOn(defaultDeps, "startRun").mockResolvedValue({ runId: "mock-route-run", sessionId: "mock-route-session", status: "running" });
  const { job } = await (await call(root.POST, "POST", input())).json();
  const response = await call(run.POST, "POST", { confirm: true }, job.id);
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.run).toMatchObject({ jobId: job.id, manual: true, status: "running", agentRunId: expect.any(String), sessionId: "mock-route-session" });
  expect((await call(item.DELETE, "DELETE", undefined, job.id)).status).toBe(409);
});
it.each(["admin2", "adult"])("every endpoint rejects non-owner %s with 403", async (user) => {
  const variants: [unknown, string, unknown][] = [
    [root.GET, "GET", undefined],
    [root.POST, "POST", input()],
    [item.PATCH, "PATCH", { enabled: true }],
    [item.DELETE, "DELETE", undefined],
    [run.POST, "POST", { confirm: true }],
    [exports.GET, "GET", undefined],
    [imports.POST, "POST", { version: 1, exportedAt: "now", jobs: [] }],
    [away.GET, "GET", undefined],
    [dismiss.POST, "POST", {}],
  ];
  for (const [handler, method, body] of variants) expect((await call(handler, method, body, "sched_test", user)).status).toBe(403);
});
it("digest dismiss hides runs and always returns JSON", async () => {
  expect((await call(away.GET)).status).toBe(200);
  expect(await (await call(dismiss.POST, "POST", {})).json()).toEqual({ ok: true });
  expect((await (await call(away.GET)).json()).line).toBeNull();
});
