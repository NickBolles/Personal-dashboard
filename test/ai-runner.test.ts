import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Fake Hermes (sessions + runs), driven by markers in the task text ---
type FakeRun = {
  run_id: string;
  session_id: string;
  status: string;
  output?: string;
  input: string;
  instructions: string;
  key: string;
  polls: number;
  stopAt?: number;
};
const fake = vi.hoisted(() => {
  const st = {
    sessions: new Map<string, { id: string; hidden: boolean; source?: string; title?: string; estimated_cost_usd: number | null }>(),
    runs: new Map<string, FakeRun>(),
    byKey: new Map<string, string>(),
    starts: [] as { key: string; input: string; model?: string }[],
    seq: 0,
    stopDelayPolls: 1,
    fileAnswer: null as string | null,
    reset() {
      st.sessions.clear();
      st.runs.clear();
      st.byKey.clear();
      st.starts.length = 0;
      st.seq = 0;
      st.stopDelayPolls = 1;
      st.fileAnswer = null;
    },
  };
  return st;
});

function answerFor(kind: string, input: string) {
  if (/FORCE_PROSE/.test(input)) return "Sure, here is what I found in prose.";
  if (/FORCE_ERROR/.test(input)) return JSON.stringify({ error: "tool missing" });
  const common = {
    title: `Mock ${kind}`,
    summary: `Summary for ${kind}`,
    body_markdown: "Body with a claim [1].",
    sources: [
      { url: "https://example.com/a", title: "A" },
      { url: "javascript:alert(1)", title: "bad" },
      { url: "http://localhost:3000/x", title: "internal" },
      { url: "https://example.com/a", title: "dup" },
      { url: "https://github.com/o/r/issues/1", title: "issue" },
    ],
    next_actions: [{ title: "Do the first thing", why: "because" }],
    open_questions: [],
    assumptions: [],
    confidence: "high",
  };
  switch (kind) {
    case "research":
      return "```json\n" + JSON.stringify({ ...common, options: [{ name: "A", pros: ["p"], cons: ["c"] }], recommendation: "A" }) + "\n```";
    case "plan":
      return JSON.stringify({
        ...common,
        steps: [{ title: "Step one" }, { title: "Step two", dependsOn: [0] }, { title: "Step three", dependsOn: [1, 5] }],
        acceptance: ["works"],
      });
    case "schedule":
      return JSON.stringify({ durationMinutes: 60, splitOk: false, preferredWindows: ["morning"], reason: "Focus work" });
    case "draft":
      return JSON.stringify({ ...common, body_markdown: "Hi team,\n\nDraft." });
    case "triage":
      return JSON.stringify({
        title: "Clean title",
        kind: "task",
        destinationKey: null,
        confidence: 0.9,
        reason: "r",
        shouldInvestigate: true,
        brief: "Find out more",
        sensitivity: "none",
      });
    case "file":
      return fake.fileAnswer ?? JSON.stringify({ suggestions: [] });
    default:
      return JSON.stringify(common);
  }
}

vi.mock("@/integrations/hermes/client", () => ({
  hermesConn: () => ({ baseUrl: "http://fake-hermes" }),
  HermesSessionClient: {
    create: vi.fn(async (_c: unknown, body: { title?: string; source?: string }) => {
      const id = `sess_${++fake.seq}`;
      fake.sessions.set(id, { id, hidden: false, source: body.source, title: body.title, estimated_cost_usd: null });
      return { session: { id } };
    }),
    update: vi.fn(async (_c: unknown, id: string, body: { hidden?: boolean }) => {
      const s = fake.sessions.get(id)!;
      if (body.hidden !== undefined) s.hidden = body.hidden;
      return { session: s };
    }),
    remove: vi.fn(async (_c: unknown, id: string) => ({ deleted: fake.sessions.delete(id) })),
    get: vi.fn(async (_c: unknown, id: string) => ({ session: fake.sessions.get(id) ?? { id } })),
  },
  HermesExecutionClient: {
    start: vi.fn(async (_c: unknown, r: { sessionId: string; input: string; instructions?: string; idempotencyKey: string; model?: string }) => {
      const existing = fake.byKey.get(r.idempotencyKey);
      if (existing) return { run_id: existing, status: fake.runs.get(existing)!.status };
      const run_id = `run_${++fake.seq}`;
      fake.starts.push({ key: r.idempotencyKey, input: r.input, model: r.model });
      const cost = Number(/FORCE_COST=([\d.]+)/.exec(r.input)?.[1] ?? 0.02);
      const s = fake.sessions.get(r.sessionId);
      if (s) s.estimated_cost_usd = cost;
      fake.runs.set(run_id, {
        run_id,
        session_id: r.sessionId,
        status: "queued",
        input: r.input,
        instructions: r.instructions ?? "",
        key: r.idempotencyKey,
        polls: 0,
      });
      fake.byKey.set(r.idempotencyKey, run_id);
      return { run_id, status: "queued" };
    }),
    status: vi.fn(async (_c: unknown, runId: string) => {
      const run = fake.runs.get(runId)!;
      run.polls++;
      if (run.status === "stopping") {
        if (run.polls >= (run.stopAt ?? 0)) run.status = "cancelled";
        return { run_id: runId, status: run.status };
      }
      if (["completed", "failed", "cancelled"].includes(run.status)) return { run_id: runId, status: run.status, output: run.output };
      const kind = /kind=(\w+)/.exec(run.instructions)?.[1] ?? "research";
      const said = run.input;
      if (/FORCE_SLOW/.test(said) || /FORCE_COST/.test(said)) {
        run.status = "running";
        return { run_id: runId, status: "running" };
      }
      if (/FORCE_APPROVAL/.test(said)) {
        run.status = "waiting_for_approval";
        return { run_id: runId, status: run.status, approval: { command: "rm -rf build" } };
      }
      run.status = "completed";
      run.output = said.startsWith("Reply again")
        ? /FORCE_PROSE/.test([...fake.runs.values()].find((r) => r.session_id === run.session_id)!.input)
          ? "still prose"
          : "{}"
        : answerFor(kind, said);
      return { run_id: runId, status: "completed", output: run.output };
    }),
    stop: vi.fn(async (_c: unknown, runId: string) => {
      const run = fake.runs.get(runId)!;
      if (!["completed", "failed", "cancelled"].includes(run.status)) {
        run.status = "stopping";
        run.stopAt = run.polls + fake.stopDelayPolls;
      }
      return { status: run.status };
    }),
  },
}));
vi.mock("@/integrations/store", async (orig) => ({ ...(await orig<typeof import("@/integrations/store")>()), isConfigured: () => true }));
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn(async () => ({})), generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }) } }));

import webpush from "web-push";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser } from "@/server/auth";
import { createPerson } from "@/server/people";
import { recentAudit } from "@/server/audit";
import * as store from "@/server/work/store";
import { saveAiSettings } from "@/server/ai/settings";
import { drainRunner, runnerTick, stopAiRunner } from "@/server/ai/runner";
import { enqueue, getJobRow } from "@/server/ai/jobs";
import { listReports } from "@/server/ai/reports";
import { dispatchOnce } from "@/server/notifications/dispatcher";
import { deliverPendingPushes, saveSubscription } from "@/server/notifications/push";
import { notify } from "@/server/notifications";
import { getPreferences, updatePreferences } from "@/server/settings";
import { workerGlobal } from "@/server/worker/status";
import * as actionRoute from "@/app/api/work/items/[id]/ai-actions/route";
import * as itemAiRoute from "@/app/api/work/items/[id]/ai/route";
import * as cancelRoute from "@/app/api/ai/jobs/[id]/cancel/route";
import * as runAnywayRoute from "@/app/api/ai/jobs/[id]/run-anyway/route";
import * as applyRoute from "@/app/api/ai/reports/[id]/apply/route";
import * as exportRoute from "@/app/api/ai/reports/[id]/export/route";
import * as usageRoute from "@/app/api/ai/usage/route";
import * as undoRoute from "@/app/api/work/ops/[id]/undo/route";
import * as suggestRoute from "@/app/api/work/conversations/suggest/route";
import { createLocalSession } from "@/server/assistant/local";

let owner: string, other: string;
const cid = "test-correlation";
const me = () => resolveUser(new Headers(), createSession(owner).token)!;

type H = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
function call(handler: unknown, opts: { user?: string | null; method?: string; body?: unknown; params?: Record<string, string>; url?: string } = {}) {
  const { user = owner, method = "GET", body, params = {}, url = "http://jarvis.test/api/x" } = opts;
  return (handler as H)(
    new NextRequest(url, {
      method,
      headers: { ...(user ? { cookie: `jarvis_session=${createSession(user).token}` } : {}), "x-jarvis-csrf": "1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await runnerTick();
    await drainRunner();
  }
}

function setup() {
  const u = me();
  const area = store.createItem(u, { kind: "area", title: "Momentum Bets" }, cid);
  const item = store.createItem(u, { kind: "thread", title: "Evaluate criteria engines", parentId: area.id }, cid);
  return { u, area, item };
}

const start = (itemId: string, action: string, extra: Record<string, unknown> = {}) =>
  call(actionRoute.POST, { method: "POST", params: { id: itemId }, body: { action, clientKey: `ck${Math.random().toString(36).slice(2, 12)}`, ...extra } });

beforeEach(() => {
  __setTestDatabase();
  fake.reset();
  process.env.JARVIS_AI_POLL_MS = "1";
  owner = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  other = createPerson({ name: "Other", username: "other", role: "adult", passcode: "synthetic-pass" }, owner).id;
  saveAiSettings({ enabled: true });
});
afterEach(() => {
  delete workerGlobal.__jarvisWorker;
  vi.clearAllMocks();
});

describe("AI actions end to end (fake Hermes)", () => {
  it("research: queued → running → succeeded, report + clean sources, visible session filed under the item, push queued", async () => {
    const { item } = setup();
    const res = await start(item.id, "research", { instructions: "focus on cost" });
    expect(res.status).toBe(202);
    const { job } = await res.json();
    expect(job.state).toBe("queued");
    // Identical active job → 200 with the same job.
    const again = await call(actionRoute.POST, { method: "POST", params: { id: item.id }, body: { action: "research", clientKey: "anotherkey1" } });
    expect(again.status).toBe(200);
    expect((await again.json()).job.id).toBe(job.id);
    await settle();
    const row = getJobRow(job.id)!;
    expect(row.state).toBe("succeeded");
    expect(row.costUsd).toBe(0.02);
    expect(row.costSource).toBe("hermes_estimate");
    const reports = listReports(owner, { subjectId: item.id });
    expect(reports).toHaveLength(1);
    const ai = await (await call(itemAiRoute.GET, { params: { id: item.id } })).json();
    expect(ai.policy.allowed).toBe(true);
    expect(ai.reports[0].sourceCount).toBe(2); // javascript:, localhost and the duplicate dropped
    expect(ai.reports[0].confidence).toBe("high");
    // Visible session kept and linked as evidence with ai_action lineage.
    expect(fake.sessions.has(row.hermesSessionId!)).toBe(true);
    const link = getDb()
      .select()
      .from(schema.workLinks)
      .where(and(eq(schema.workLinks.itemId, item.id), eq(schema.workLinks.kind, "chat_session")))
      .get();
    expect(link).toMatchObject({ role: "evidence", lineage: "ai_action", targetId: row.hermesSessionId });
    // The prompt carries the read-only marker, untrusted text in <data>, and no model by default (perRunModel off).
    expect(fake.starts[0]!.input).toContain('<data source="nick_focus">');
    expect(fake.starts[0]!.model).toBeUndefined();
    const n = getDb().select().from(schema.notifications).where(eq(schema.notifications.type, "ai.report_ready")).get();
    expect(n).toMatchObject({ category: "ai_report", pushState: "pending" });
    expect(n!.deepLink).toContain(`report=${reports[0]!.id}`);
    // Job rows never hold prompts or output.
    expect(row.errorMessage).toBeNull();
    expect(JSON.stringify(row)).not.toContain("Mock research");
    // Export formats.
    const md = await call(exportRoute.GET, { params: { id: reports[0]!.id }, url: "http://jarvis.test/x?format=md" });
    expect(md.headers.get("content-disposition")).toMatch(/\.md"/);
    expect(await md.text()).toContain("## Sources");
    const js = await call(exportRoute.GET, { params: { id: reports[0]!.id }, url: "http://jarvis.test/x?format=json" });
    expect(JSON.parse(await js.text()).sources).toHaveLength(2);
    // Usage reconciles with job costs; CSV export.
    const usage = await (await call(usageRoute.GET, { url: "http://jarvis.test/x?days=7" })).json();
    expect(usage.totals.costUsd).toBeCloseTo(0.02);
    const csv = await (await call(usageRoute.GET, { url: "http://jarvis.test/x?format=csv" })).text();
    expect(csv.split("\n")[0]).toContain("cost_usd");
  });

  it("schedule: hidden session deleted, slots computed on the server, no calendar data sent to Hermes", async () => {
    const { item } = setup();
    getDb()
      .insert(schema.sourceSnapshots)
      .values({
        source: "skylight",
        state: "ok",
        payload: JSON.stringify({ events: [{ title: "SECRET_EVENT_TITLE", startsAt: new Date(Date.now() + 86400_000).toISOString() }] }),
      })
      .run();
    const { job } = await (await start(item.id, "schedule")).json();
    await settle();
    const row = getJobRow(job.id)!;
    expect(row.state).toBe("succeeded");
    expect(fake.sessions.has(row.hermesSessionId!)).toBe(false);
    for (const s of fake.starts) {
      expect(s.input).not.toContain("SECRET_EVENT_TITLE");
      expect(s.input).not.toMatch(/calendar_event|startsAt/);
    }
    const rep = listReports(owner, { subjectId: item.id })[0]!;
    expect((rep.structured as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
    const r = await call(applyRoute.POST, { method: "POST", params: { id: rep.id }, body: { what: "dates", slot: 0 } });
    expect(r.status).toBe(200);
    expect((await r.json()).item.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Calendar writes stay off.
    const cal = await call(applyRoute.POST, { method: "POST", params: { id: rep.id }, body: { what: "calendar_event", slot: 0 } });
    expect(cal.status).toBe(409);
    expect((await cal.json()).code).toBe("calendar_write_disabled");
  });

  it("plan → create child items with dependencies (one op) → undo removes the untouched ones; next action applies", async () => {
    const { item } = setup();
    await start(item.id, "plan");
    await settle();
    const rep = listReports(owner, { subjectId: item.id })[0]!;
    const r = await (await call(applyRoute.POST, { method: "POST", params: { id: rep.id }, body: { what: "plan_children" } })).json();
    expect(r.op.kind).toBe("ai_plan_create");
    const kids = store.getDetail(owner, item.id).children;
    expect(kids.map((k) => k.title)).toEqual(["Step one", "Step two", "Step three"]);
    expect(getDb().select().from(schema.workDependencies).all()).toHaveLength(2); // dependsOn 5 (missing) ignored
    const undo = await call(undoRoute.POST, { method: "POST", params: { id: r.op.id }, body: {} });
    expect(undo.status).toBe(200);
    expect(store.getDetail(owner, item.id).children).toHaveLength(0);
    const na = await (await call(applyRoute.POST, { method: "POST", params: { id: rep.id }, body: { what: "next_action", index: 0 } })).json();
    expect(na.item.nextAction).toBe("Do the first thing");
    expect(recentAudit(50).some((a) => a.action === "ai.report.apply")).toBe(true);
  });

  it("Finance area: no AI actions (403), nothing reaches Hermes; work.ai is required", async () => {
    const u = me();
    const fin = store.createItem(u, { kind: "area", title: "Finance" }, cid);
    const item = store.createItem(u, { kind: "thread", title: "Compare savings accounts", parentId: fin.id }, cid);
    const res = await start(item.id, "research");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ai_excluded_area");
    const ai = await (await call(itemAiRoute.GET, { params: { id: item.id } })).json();
    expect(ai.policy).toEqual({ allowed: false, reason: "ai_excluded_area" });
    // Finance-looking text on an ordinary item is refused too.
    const { item: plain } = setup();
    store.updateItem(u, plain.id, { summary: "Chase checking balance $4,210" }, cid);
    expect((await start(plain.id, "research")).status).toBe(403);
    await settle();
    expect(fake.starts).toHaveLength(0);
    // An adult without work.ai gets 403.
    const o = resolveUser(new Headers(), createSession(other).token)!;
    const theirs = store.createItem(o, { kind: "area", title: "Mine" }, cid);
    expect(
      (await call(actionRoute.POST, { user: other, method: "POST", params: { id: theirs.id }, body: { action: "research", clientKey: "abcdefgh" } })).status,
    ).toBe(403);
  });

  it("Suggest with AI (filing): screened titles only, Finance never offered, answers kept only for real destinations", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-value");
    const { u, area } = setup();
    const fin = store.createItem(u, { kind: "area", title: "Finance" }, cid);
    const a = createLocalSession(u, "Enable v5 rollout");
    const b = createLocalSession(u, "Pay card 4111 1111 1111 1111");
    const go = () => call(suggestRoute.POST, { method: "POST", body: { clientKey: `ck${Math.random().toString(36).slice(2, 12)}` } });
    fake.fileAnswer = JSON.stringify({
      suggestions: [
        { sessionId: a.id, destinationKey: area.id, confidence: 0.9, reason: "V5 work" },
        { sessionId: b.id, destinationKey: area.id, confidence: 0.9, reason: "not asked" },
      ],
    });
    const res = await go();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ asked: 1, excluded: 1 });
    await settle();
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]!.input).toContain(a.id);
    expect(fake.starts[0]!.input).not.toContain(b.id);
    expect(fake.starts[0]!.input).not.toContain(fin.id); // AI-excluded area: never a destination
    let state = await (await call(suggestRoute.GET)).json();
    expect(state.job).toMatchObject({ kind: "file", state: "succeeded" });
    expect(state.suggestions).toEqual([{ sessionId: a.id, itemId: area.id, confidence: 0.9, reason: "V5 work" }]);
    // A key outside the offered destinations (Finance, or invented) is dropped to "no home".
    fake.fileAnswer = JSON.stringify({ suggestions: [{ sessionId: a.id, destinationKey: fin.id, confidence: 0.7, reason: "money" }] });
    expect((await go()).status).toBe(202);
    await settle();
    state = await (await call(suggestRoute.GET)).json();
    expect(state.suggestions).toEqual([{ sessionId: a.id, itemId: null, confidence: 0.7, reason: "money" }]);
    // work.ai is required.
    expect((await call(suggestRoute.POST, { user: other, method: "POST", body: { clientKey: "abcdefgh" } })).status).toBe(403);
    vi.unstubAllEnvs();
  });

  it("an item moved into Finance after enqueue is skipped at execution", async () => {
    const { u, item } = setup();
    const { job } = await (await start(item.id, "research")).json();
    const fin = store.createItem(u, { kind: "area", title: "Finance" }, cid);
    store.moveItem(u, item.id, fin.id, cid);
    await settle();
    expect(getJobRow(job.id)).toMatchObject({ state: "skipped", errorCode: "finance_excluded" });
    expect(fake.starts).toHaveLength(0);
  });

  it("budget: second job is budget_blocked; Run anyway is audited and runs it", async () => {
    saveAiSettings({ dailyBudgetUsd: 0.26 });
    const { item, u, area } = setup();
    const b = store.createItem(u, { kind: "thread", title: "Second", parentId: area.id }, cid);
    const j1 = (await (await start(item.id, "research")).json()).job;
    await settle();
    expect(getJobRow(j1.id)!.state).toBe("succeeded");
    const j2 = (await (await start(b.id, "research")).json()).job;
    await settle();
    expect(getJobRow(j2.id)!.state).toBe("budget_blocked");
    expect(getDb().select().from(schema.notifications).where(eq(schema.notifications.type, "ai.budget")).all()).toHaveLength(1);
    const r = await call(runAnywayRoute.POST, { method: "POST", params: { id: j2.id }, body: {} });
    expect((await r.json()).state).toBe("queued");
    await settle();
    expect(getJobRow(j2.id)!.state).toBe("succeeded");
    expect(recentAudit(100).some((a) => a.action === "ai.budget_override" && a.sourceRecord === j2.id)).toBe(true);
  });

  it("switching to subscription billing releases $-budget holds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-usage-"));
    const file = path.join(dir, "usage.json");
    const at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ fetched_at: at, providers: { "openai-codex": { weekly_used_percent: 10, fetched_at: at } } }));
    process.env.JARVIS_HERMES_USAGE_FILE = file;
    try {
      saveAiSettings({ dailyBudgetUsd: 0.26 });
      const { item, u, area } = setup();
      const b = store.createItem(u, { kind: "thread", title: "Held by dollars", parentId: area.id }, cid);
      const j1 = (await (await start(item.id, "research")).json()).job;
      await settle();
      expect(getJobRow(j1.id)!.state).toBe("succeeded");
      const j2 = (await (await start(b.id, "research")).json()).job;
      await settle();
      expect(getJobRow(j2.id)).toMatchObject({ state: "budget_blocked", errorCode: null });
      saveAiSettings({ billing: { mode: "codex", stopAtPct: 48 } });
      await settle();
      expect(getJobRow(j2.id)!.state).toBe("succeeded");
    } finally {
      delete process.env.JARVIS_HERMES_USAGE_FILE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chat default reasoning: "" resets it to the model default', () => {
    updatePreferences({ hermes: { defaultReasoning: "high" } }, owner);
    expect(getPreferences(owner).hermes.defaultReasoning).toBe("high");
    updatePreferences({ hermes: { defaultReasoning: "" } }, owner);
    expect(getPreferences(owner).hermes.defaultReasoning).toBeUndefined();
  });

  it("subscription meter: background jobs stop at the weekly line (fail closed), user jobs run, $ budget ignored", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-usage-"));
    const file = path.join(dir, "usage.json");
    const write = (pct: number, at = new Date()) =>
      fs.writeFileSync(
        file,
        JSON.stringify({ fetched_at: at.toISOString(), providers: { "openai-codex": { weekly_used_percent: pct, fetched_at: at.toISOString() } } }),
      );
    process.env.JARVIS_HERMES_USAGE_FILE = file;
    try {
      saveAiSettings({ dailyBudgetUsd: 0, billing: { mode: "codex", stopAtPct: 48 } });
      const { item, u, area } = setup();
      const b = store.createItem(u, { kind: "thread", title: "Background one", parentId: area.id }, cid);
      // No snapshot yet: background stops, a person's job still runs (and the $0 budget doesn't apply).
      const bg = enqueue({
        userId: owner,
        kind: "research",
        subjectType: "work_item",
        subjectId: b.id,
        clientKey: "bgmeter01",
        background: true,
        correlationId: cid,
      }).job;
      const fg = (await (await start(item.id, "research")).json()).job;
      await settle();
      expect(getJobRow(fg.id)!.state).toBe("succeeded");
      expect(getJobRow(bg.id)).toMatchObject({ state: "budget_blocked", errorCode: "quota" });
      expect(JSON.parse(getJobRow(bg.id)!.params).background).toBe(true);
      // Over the line: still held.
      write(48);
      await settle();
      expect(getJobRow(bg.id)!.state).toBe("budget_blocked");
      // Stale (> 2 h) snapshot under the line: still held.
      write(10, new Date(Date.now() - 3 * 3600_000));
      await settle();
      expect(getJobRow(bg.id)!.state).toBe("budget_blocked");
      // Switching back to API billing releases held jobs too.
      saveAiSettings({ dailyBudgetUsd: 5, billing: { mode: "api", stopAtPct: 48 } });
      await settle();
      expect(getJobRow(bg.id)!.state).toBe("succeeded");
      saveAiSettings({ billing: { mode: "codex", stopAtPct: 48 } });
      // Fresh and under the line: released and run.
      write(10);
      await settle();
      expect(getJobRow(bg.id)!.state).toBe("succeeded");
      const meter = (await (await call(usageRoute.GET, { url: "http://jarvis.test/api/ai/usage?days=1" })).json()).meter;
      expect(meter).toMatchObject({ mode: "codex", state: "ok", usedPct: 10, summary: "Codex 10% of week", backgroundAllowed: true });
    } finally {
      delete process.env.JARVIS_HERMES_USAGE_FILE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancel while running → cancelling → cancelled only after Hermes reports terminal", async () => {
    const { item } = setup();
    fake.stopDelayPolls = 3;
    await call(itemAiRoute.GET, { params: { id: item.id } });
    const { job } = await (
      await call(actionRoute.POST, { method: "POST", params: { id: item.id }, body: { action: "research", clientKey: "slowjob1", instructions: "FORCE_SLOW" } })
    ).json();
    await runnerTick();
    await new Promise((r) => setTimeout(r, 30));
    expect(getJobRow(job.id)!.state).toBe("running");
    const c = await (await call(cancelRoute.POST, { method: "POST", params: { id: job.id }, body: {} })).json();
    expect(c.state).toBe("cancelling");
    await runnerTick(); // propagates the cancel to the in-flight run
    await drainRunner();
    const row = getJobRow(job.id)!;
    expect(row.state).toBe("cancelled");
    expect(fake.runs.get(row.hermesRunId!)!.status).toBe("cancelled");
  });

  it("cancel still reaches a running job after AI is disabled", async () => {
    const { item } = setup();
    fake.stopDelayPolls = 2;
    await call(itemAiRoute.GET, { params: { id: item.id } });
    const { job } = await (
      await call(actionRoute.POST, { method: "POST", params: { id: item.id }, body: { action: "research", clientKey: "slowjob2", instructions: "FORCE_SLOW" } })
    ).json();
    await runnerTick();
    await new Promise((r) => setTimeout(r, 30));
    expect(getJobRow(job.id)!.state).toBe("running");
    saveAiSettings({ enabled: false });
    stopAiRunner();
    expect((await (await call(cancelRoute.POST, { method: "POST", params: { id: job.id }, body: {} })).json()).state).toBe("cancelling");
    await new Promise((r) => setTimeout(r, 400)); // the kicked maintenance pass aborts the in-flight run
    await drainRunner();
    expect(getJobRow(job.id)!.state).toBe("cancelled");
    expect(fake.runs.get(getJobRow(job.id)!.hermesRunId!)!.status).toBe("cancelled");
  });

  it("restart: expired lease with a run id is adopted (no second run); without one it's requeued with the same key", async () => {
    const { item, u, area } = setup();
    const { job } = enqueue({ userId: owner, kind: "research", subjectType: "work_item", subjectId: item.id, clientKey: "restart01", correlationId: cid });
    // Simulate a crash after Hermes accepted the run.
    const { HermesSessionClient, HermesExecutionClient } = await import("@/integrations/hermes/client");
    const { session } = await HermesSessionClient.create({ baseUrl: "x" }, { title: "t" });
    const row0 = getJobRow(job.id)!;
    const run = await HermesExecutionClient.start(
      { baseUrl: "x" },
      { sessionId: session.id, input: "task", instructions: "JARVIS_AI_JOB kind=research", idempotencyKey: row0.idempotencyKey },
    );
    const past = new Date(Date.now() - 1000).toISOString();
    getDb()
      .update(schema.aiJobs)
      .set({ state: "running", leaseOwner: "dead:pid", leaseUntil: past, hermesSessionId: session.id, hermesRunId: run.run_id, attempt: 1 })
      .where(eq(schema.aiJobs.id, job.id))
      .run();
    await settle();
    expect(getJobRow(job.id)!.state).toBe("succeeded");
    expect(fake.starts.filter((s) => s.key === row0.idempotencyKey)).toHaveLength(1);
    // No run id: requeued with the same idempotency key, and Hermes sees exactly one run.
    const b = store.createItem(u, { kind: "thread", title: "B", parentId: area.id }, cid);
    const j2 = enqueue({ userId: owner, kind: "research", subjectType: "work_item", subjectId: b.id, clientKey: "restart02", correlationId: cid }).job;
    const key2 = getJobRow(j2.id)!.idempotencyKey;
    getDb().update(schema.aiJobs).set({ state: "running", leaseOwner: "dead:pid", leaseUntil: past, attempt: 1 }).where(eq(schema.aiJobs.id, j2.id)).run();
    await settle();
    expect(getJobRow(j2.id)).toMatchObject({ state: "succeeded", idempotencyKey: key2 });
    expect(fake.starts.filter((s) => s.key === key2)).toHaveLength(1);
  });

  it("approvals: hidden jobs fail approval_required; visible jobs wait and notify hermes_input", async () => {
    const { item, u, area } = setup();
    const s = (
      await (
        await call(actionRoute.POST, {
          method: "POST",
          params: { id: item.id },
          body: { action: "schedule", clientKey: "approval1", instructions: "FORCE_APPROVAL" },
        })
      ).json()
    ).job;
    await settle(3);
    expect(getJobRow(s.id)).toMatchObject({ state: "failed", errorCode: "approval_required" });
    const b = store.createItem(u, { kind: "thread", title: "B", parentId: area.id }, cid);
    const v = (
      await (
        await call(actionRoute.POST, {
          method: "POST",
          params: { id: b.id },
          body: { action: "research", clientKey: "approval2", instructions: "FORCE_APPROVAL" },
        })
      ).json()
    ).job;
    await runnerTick();
    await new Promise((r) => setTimeout(r, 40));
    expect(getJobRow(v.id)!.state).toBe("waiting_approval");
    expect(getDb().select().from(schema.notifications).where(eq(schema.notifications.category, "hermes_input")).all()).toHaveLength(1);
    // The visible run is registered with the conversation machinery: owned session + run-store row awaiting approval.
    const vr = getJobRow(v.id)!;
    expect(getDb().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, vr.hermesSessionId!)).get()?.userId).toBe(owner);
    expect(getDb().select().from(schema.runs).where(eq(schema.runs.runId, vr.hermesRunId!)).get()).toMatchObject({
      userId: owner,
      sessionId: vr.hermesSessionId,
      status: "waiting_for_approval",
      notifiedCompletion: true,
    });
    await call(cancelRoute.POST, { method: "POST", params: { id: v.id }, body: {} });
    await runnerTick();
    await drainRunner();
    expect(getJobRow(v.id)!.state).toBe("cancelled");
    expect(getDb().select().from(schema.runs).where(eq(schema.runs.runId, vr.hermesRunId!)).get()?.status).toBe("cancelled");
  });

  it("per-job cost cap stops the run when Hermes reports cost mid-run (flag on)", async () => {
    saveAiSettings({ hermes: { perRunModel: true, midRunCost: true, imageInput: false } });
    const { item } = setup();
    const { job } = await (
      await call(actionRoute.POST, {
        method: "POST",
        params: { id: item.id },
        body: { action: "research", clientKey: "costcap1", instructions: "FORCE_COST=5" },
      })
    ).json();
    await settle(3);
    expect(getJobRow(job.id)).toMatchObject({ state: "failed", errorCode: "cost_cap" });
  });

  it("prose answers get one repair turn, then fail bad_output with controlled text", async () => {
    const { item } = setup();
    const { job } = await (
      await call(actionRoute.POST, {
        method: "POST",
        params: { id: item.id },
        body: { action: "research", clientKey: "prose0001", instructions: "FORCE_PROSE" },
      })
    ).json();
    await settle(3);
    const row = getJobRow(job.id)!;
    expect(row).toMatchObject({ state: "failed", errorCode: "bad_output" });
    expect(row.errorMessage).not.toMatch(/prose/);
    expect(fake.starts.some((s) => s.key.endsWith(":repair"))).toBe(true);
  });
});

describe("standalone push dispatcher", () => {
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } };
  // Default quiet hours (22:00–07:00) would hold these pushes when CI runs at night.
  beforeEach(() => updatePreferences({ quietHours: { enabled: false } }, owner));

  it("delivers pending pushes with the worker disabled; skips while the worker runs; never double-sends", async () => {
    saveSubscription(owner, sub);
    notify({ type: "t", category: "ai_report", severity: "normal", title: "Report ready", body: "b", source: "work", deepLink: "/areas" }, owner);
    workerGlobal.__jarvisWorker = { running: false } as never;
    expect(await dispatchOnce()).toEqual({ skipped: "worker" });
    delete workerGlobal.__jarvisWorker;
    expect(await dispatchOnce()).toEqual({ sent: 1 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(getDb().select().from(schema.notifications).get()!.pushState).toBe("sent");
    // Concurrent outbox passes (worker + dispatcher) claim rows: one send per row.
    notify({ type: "t2", category: "ai_report", severity: "normal", title: "Again", body: "b", source: "work", deepLink: "/areas" }, owner);
    await Promise.all([deliverPendingPushes(), deliverPendingPushes(), dispatchOnce()]);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("reclaims a stale `sending` claim even when nothing else is pending", async () => {
    saveSubscription(owner, sub);
    notify({ type: "t3", category: "ai_report", severity: "normal", title: "Stuck", body: "b", source: "work", deepLink: "/areas" }, owner);
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    getDb().update(schema.notifications).set({ pushState: "sending", pushAttemptedAt: stale }).run();
    expect(await dispatchOnce()).toEqual({ sent: 1 });
    expect(getDb().select().from(schema.notifications).get()!.pushState).toBe("sent");
  });
});
