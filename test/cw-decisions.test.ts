/** CW-2/CW-3 decisions (D-n): state machine, head projection + back-compat, owner-only answers, supersede, defaults, migration back-fill. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession, resolveUser, type CurrentUser } from "@/server/auth";
import * as store from "@/server/work/store";
import { withVia } from "@/server/work/actor";
import { listDecisions } from "@/server/work/decisions";
import {
  answerDecisionRef,
  applyDueDecisions,
  deferDecision,
  findDecision,
  listDecisionRows,
  raiseDecision,
  withdrawDecision,
} from "@/server/work/decision-store";
import { NextRequest } from "next/server";
import { __resetAgentRate, mintAgentToken } from "@/server/agent-access/tokens";
import * as mcpRoute from "@/app/api/mcp/route";
import * as answerRoute from "@/app/api/coordinator/decisions/[ref]/answer/route";
import { nextState, packSchema, shouldDefault, sortByUrgency, validateRaise, type Decision } from "@/lib/cw-decisions";

const cid = "test";
let owner: CurrentUser;
let itemId: string;

function newItem(title = "Decide things") {
  const area = store.createItem(owner, { parentId: null, kind: "area", title: `Area ${title}` }, cid);
  return store.createItem(owner, { parentId: area.id, kind: "thread", title }, cid).id;
}
const head = (id = itemId) => store.listItems(owner.id).find((i) => i.id === id)!.decision;
const row = (ref: string) => findDecision(getDb(), owner.id, ref)!;
const inMin = (m: number, from = Date.now()) => new Date(from + m * 60_000).toISOString();

beforeEach(() => {
  __setTestDatabase();
  const id = claimInstance({ setupCode: "TESTCODE", name: "Owner", passcode: "synthetic-pass" });
  owner = resolveUser(new Headers(), createSession(id).token)!;
  itemId = newItem();
});

describe("pure rules", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  it("defaults only for low-risk decisions, paired, from the choices, 10 min–30 days ahead", () => {
    const base = { question: "Q", choices: ["Yes", "No"] };
    expect(validateRaise({ ...base, defaultChoice: "Yes", expiresAt: "2026-11-08T13:00:00Z" }, now).ok).toBe(true);
    expect(validateRaise({ ...base, risk: ["credential"], defaultChoice: "Yes", expiresAt: "2026-11-08T13:00:00Z" }, now)).toMatchObject({
      code: "default_risk",
    });
    expect(validateRaise({ ...base, defaultChoice: "Yes" }, now)).toMatchObject({ code: "default_pair" });
    expect(validateRaise({ ...base, defaultChoice: "Maybe", expiresAt: "2026-11-08T13:00:00Z" }, now)).toMatchObject({ code: "default_choice" });
    expect(validateRaise({ ...base, defaultChoice: "Yes", expiresAt: "2026-11-08T12:05:00Z" }, now)).toMatchObject({ code: "expires_at" });
    expect(validateRaise({ ...base, recommended: "Other" }, now)).toMatchObject({ code: "recommended" });
    for (const url of ["javascript:alert(1)", "//evil.example", "http://x.example", "data:text/html,x"])
      expect(packSchema.safeParse({ evidence: [{ kind: "url", label: "x", url }] }).success).toBe(false);
    expect(
      packSchema.safeParse({
        evidence: [
          { kind: "pr", label: "x", url: "https://github.com/o/r/pull/1" },
          { kind: "item", label: "y", url: "/areas?item=wk_1" },
        ],
      }).success,
    ).toBe(true);
    expect(validateRaise({ ...base, pack: { options: [{ choice: "Other", effect: "x" }] } }, now)).toMatchObject({ code: "pack_option" });
  });
  it("state machine", () => {
    expect(nextState("open", "answer")).toBe("answered");
    expect(nextState("deferred", "answer")).toBe("answered");
    expect(nextState("answered", "answer")).toBeNull();
    expect(nextState("superseded", "answer")).toBeNull();
    expect(nextState("open", "default")).toBe("defaulted");
    expect(nextState("deferred", "default")).toBeNull();
    expect(nextState("answered", "supersede")).toBeNull();
    expect(nextState("defaulted", "reopen")).toBe("open");
    expect(nextState("superseded", "reopen")).toBeNull();
  });
  it("shouldDefault never applies to a risk-flagged decision", () => {
    const d = { state: "open" as const, defaultChoice: "Yes", expiresAt: "2026-11-08T11:00:00Z" };
    expect(shouldDefault({ ...d, risk: [] }, now)).toBe(true);
    expect(shouldDefault({ ...d, risk: ["device"] }, now)).toBe(false);
    expect(shouldDefault({ ...d, risk: [], expiresAt: "2026-11-08T13:00:00Z" }, now)).toBe(false);
    expect(shouldDefault({ ...d, risk: [], state: "answered" }, now)).toBe(false);
  });
  it("urgency: ageing first, then risk, then soonest default, then newest", () => {
    const mk = (seq: number, createdAt: string, risk: Decision["risk"] = [], expiresAt: string | null = null) => ({ seq, createdAt, risk, expiresAt });
    const order = sortByUrgency(
      [
        mk(1, "2026-11-08T11:00:00Z"),
        mk(2, "2026-11-08T11:30:00Z", ["money"]),
        mk(3, "2026-11-06T09:00:00Z"),
        mk(4, "2026-11-08T10:00:00Z", [], "2026-11-08T12:30:00Z"),
        mk(5, "2026-11-08T11:50:00Z"),
      ],
      now,
    ).map((d) => d.seq);
    expect(order).toEqual([3, 2, 4, 5, 1]);
  });
});

describe("decision store", () => {
  it("several open per item; head projection keeps the legacy JSON with a ref", () => {
    const a = raiseDecision(owner.id, itemId, { question: "Ship V1?", choices: ["Yes", "No"] }, { raisedBy: "agent:chiefofstaff", correlationId: cid });
    const b = raiseDecision(owner.id, itemId, { question: "Ship V3?", choices: ["Yes", "No"] }, { raisedBy: "agent:chiefofstaff", correlationId: cid });
    expect([a.ref, b.ref]).toEqual(["D-1", "D-2"]);
    expect(head()).toMatchObject({ question: "Ship V1?", ref: "D-1", choices: ["Yes", "No"] });
    const keys = listDecisions(owner)
      .entries.filter((e) => e.itemId === itemId)
      .map((e) => e.key);
    expect(keys.sort()).toEqual([`decision:D-2`, `item:${itemId}`].sort());
    expect(listDecisions(owner).entries.find((e) => e.ref === "D-1")?.askedBy).toBe("chiefofstaff");
  });

  it("legacy answer route answers the head, promotes the next one, and undo reopens it", () => {
    raiseDecision(owner.id, itemId, { question: "Ship V1?", choices: ["Yes", "No"] }, { raisedBy: "agent:x", correlationId: cid });
    raiseDecision(owner.id, itemId, { question: "Ship V3?", choices: ["Yes", "No"] }, { raisedBy: "agent:x", correlationId: cid });
    const out: store.OpOut = {};
    const item = store.answerDecision(owner, itemId, "Yes", cid, out);
    expect(item.summary).toMatch(/Decision: Ship V1\? → Yes/);
    expect(row("D-1")).toMatchObject({ state: "answered", answeredChoice: "Yes", answeredVia: "item" });
    expect(head()).toMatchObject({ ref: "D-2" });
    store.undoOp(owner, out.op!.id, cid);
    expect(row("D-1").state).toBe("open");
    expect(row("D-1").answeredChoice).toBeNull();
    expect(head()).toMatchObject({ ref: "D-1" });
    expect(row("D-2").state).toBe("open");
  });

  it("answers a non-head decision by D-n (undoable) and a repeat of the same answer is a no-op", () => {
    raiseDecision(owner.id, itemId, { question: "A?", choices: ["Yes"] }, { raisedBy: "agent:x", correlationId: cid });
    raiseDecision(owner.id, itemId, { question: "B?", choices: ["Yes"] }, { raisedBy: "agent:x", correlationId: cid });
    const out: store.OpOut = {};
    expect(answerDecisionRef(owner.id, "D-2", "Yes", "queue", cid, out).decision.state).toBe("answered");
    expect(head()).toMatchObject({ ref: "D-1" });
    expect(answerDecisionRef(owner.id, "D-2", "Yes", "push", cid).repeated).toBe(true);
    expect(() => answerDecisionRef(owner.id, "D-2", "No", "queue", cid)).toThrow(/already answered/);
    store.undoOp(owner, out.op!.id, cid);
    expect(row("D-2").state).toBe("open");
  });

  it("agents can never answer or defer (owner session only)", () => {
    raiseDecision(owner.id, itemId, { question: "A?", choices: ["Yes"] }, { raisedBy: "agent:x", correlationId: cid });
    expect(() => withVia("agent:x", () => answerDecisionRef(owner.id, "D-1", "Yes", "queue", cid))).toThrow(/Only the owner/);
    expect(() => withVia("agent:x", () => store.answerDecision(owner, itemId, "Yes", cid))).toThrow(/Only the owner/);
    expect(() => withVia("agent:x", () => deferDecision(owner.id, "D-1", inMin(60), cid))).toThrow(/Only the owner/);
    expect(row("D-1").state).toBe("open");
  });

  it("supersede/withdraw only by the raiser; links old → new", () => {
    raiseDecision(owner.id, itemId, { question: "Old?", choices: ["Yes"] }, { raisedBy: "agent:a", correlationId: cid });
    expect(() => raiseDecision(owner.id, itemId, { question: "New?", supersedes: "D-1" }, { raisedBy: "agent:b", correlationId: cid })).toThrow(
      /Only the raiser/,
    );
    const n = raiseDecision(owner.id, itemId, { question: "New?", choices: ["Yes"], supersedes: "D-1" }, { raisedBy: "agent:a", correlationId: cid });
    expect(row("D-1")).toMatchObject({ state: "superseded", supersededBy: n.id });
    expect(head()).toMatchObject({ ref: n.ref, question: "New?" });
    expect(() => withdrawDecision(owner.id, n.ref, "agent:b", "nope", cid)).toThrow(/Only the raiser/);
    withdrawDecision(owner.id, n.ref, "agent:a", "not needed", cid);
    expect(head()).toBeNull();
    expect(() => withdrawDecision(owner.id, n.ref, "agent:a", "again", cid)).toThrow(/already withdrawn/);
  });

  it("defaults apply on expiry for low-risk only, audited and undoable; risk-flagged never default", () => {
    const now = Date.now();
    raiseDecision(
      owner.id,
      itemId,
      { question: "Low?", choices: ["Yes", "No"], defaultChoice: "Yes", expiresAt: inMin(20, now) },
      { raisedBy: "agent:x", correlationId: cid },
    );
    const risky = raiseDecision(
      owner.id,
      itemId,
      { question: "Key?", choices: ["Rotate", "Keep"], risk: ["credential"] },
      { raisedBy: "agent:x", correlationId: cid },
    );
    // Even a row tampered into having a default (bypassing validateRaise) never defaults while risk-flagged.
    getDb()
      .update(schema.decisions)
      .set({ defaultChoice: "Rotate", expiresAt: inMin(1, now) })
      .where(eq(schema.decisions.id, risky.id))
      .run();
    expect(applyDueDecisions(new Date(now + 5 * 60_000)).defaulted).toEqual([]);
    const res = applyDueDecisions(new Date(now + 30 * 60_000));
    expect(res.defaulted).toEqual(["D-1"]);
    expect(row("D-1")).toMatchObject({ state: "defaulted", answeredChoice: "Yes", answeredVia: "default" });
    expect(row(risky.ref)).toMatchObject({ state: "open", defaultChoice: null, expiresAt: null });
    expect(store.listItems(owner.id).find((i) => i.id === itemId)!.summary).toMatch(/Low\? → Yes \(default\)/);
    const audit = getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "decision.default")).all();
    expect(audit.map((a) => a.result).sort()).toEqual(["ok", "rejected"]);
    // Undo from Activity (latest edit op on the item) brings it back.
    const op = getDb()
      .select()
      .from(schema.workOps)
      .where(eq(schema.workOps.itemId, itemId))
      .all()
      .find((o) => o.payload.includes("decisionOp"))!;
    store.undoOp(owner, op.id, cid);
    expect(row("D-1").state).toBe("open");
  });

  it("defer hides it and moves the head; it comes back when due", () => {
    raiseDecision(owner.id, itemId, { question: "A?" }, { raisedBy: "agent:x", correlationId: cid });
    raiseDecision(owner.id, itemId, { question: "B?" }, { raisedBy: "agent:x", correlationId: cid });
    const until = inMin(60);
    deferDecision(owner.id, "D-1", until, cid);
    expect(head()).toMatchObject({ ref: "D-2" });
    expect(listDecisions(owner).entries.some((e) => e.ref === "D-1")).toBe(false);
    expect(applyDueDecisions(new Date(Date.parse(until) + 1000)).undeferred).toEqual(["D-1"]);
    expect(row("D-1").state).toBe("open");
    expect(() => deferDecision(owner.id, "D-1", inMin(60 * 24 * 40), cid)).toThrow(/30 days/);
  });

  it("legacy updateItem decision writes mirror into the table (raise, replace, clear, undo)", () => {
    const out: store.OpOut = {};
    store.updateItem(owner, itemId, { decision: { question: "Owner Q?", choices: ["A", "B"] } }, cid, out);
    expect(head()).toMatchObject({ question: "Owner Q?", ref: "D-1" });
    expect(row("D-1")).toMatchObject({ state: "open", raisedBy: `person:${owner.id}` });
    // Undo of the raise withdraws the row.
    store.undoOp(owner, out.op!.id, cid);
    expect(head()).toBeNull();
    expect(row("D-1").state).toBe("withdrawn");
    store.updateItem(owner, itemId, { decision: { question: "Q2?" } }, cid);
    store.updateItem(owner, itemId, { decision: { question: "Q3?" } }, cid);
    expect(row("D-2")).toMatchObject({ state: "superseded" });
    expect(head()).toMatchObject({ ref: "D-3" });
    store.updateItem(owner, itemId, { decision: null }, cid);
    expect(row("D-3").state).toBe("withdrawn");
    expect(listDecisionRows(owner.id, { states: ["open"] })).toEqual([]);
  });

  it("D-n numbers are per owner and never reused", () => {
    raiseDecision(owner.id, itemId, { question: "A?" }, { raisedBy: "agent:x", correlationId: cid });
    withdrawDecision(owner.id, "D-1", "agent:x", "gone", cid);
    expect(raiseDecision(owner.id, itemId, { question: "B?" }, { raisedBy: "agent:x", correlationId: cid }).ref).toBe("D-2");
  });
});

describe("migration 0043 back-fill", () => {
  it("turns open single-per-item decisions into D-n rows (oldest first) and stamps the ref; old JSON stays readable", () => {
    const file = readFileSync(join(process.cwd(), "drizzle/0043_coordinator_workflow.sql"), "utf8");
    const backfill = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => /INSERT INTO `decisions`|UPDATE `work_items` SET `decision`/.test(s));
    expect(backfill).toHaveLength(2);
    const second = newItem("Device item");
    const third = newItem("Destructive item");
    const db = getDb();
    const T = schema.workItems;
    db.update(T)
      .set({ decision: JSON.stringify({ question: "@devchief: Newer?", choices: ["Yes"], askedAt: "2026-11-07T10:00:00.000Z" }) })
      .where(eq(T.id, itemId))
      .run();
    db.update(T)
      .set({
        decision: JSON.stringify({
          question: "Turn off?",
          choices: [],
          askedAt: "2026-11-05T10:00:00.000Z",
          action: { label: "Confirm on House", href: "/house" },
        }),
      })
      .where(eq(T.id, second))
      .run();
    db.update(T)
      .set({ decision: JSON.stringify({ question: "@x proposes: archive. dup", choices: ["Do it", "Not now"], askedAt: "2026-11-06T10:00:00.000Z" }) })
      .where(eq(T.id, third))
      .run();
    db.insert(schema.workEvents)
      .values({
        id: "ev1",
        itemId,
        actor: owner.id,
        kind: "edit",
        reason: "Needs your decision: @devchief: Newer?",
        via: "agent:devchief",
        at: "2026-11-07T10:00:00.000Z",
      })
      .run();
    db.delete(schema.decisions).run();
    for (const s of backfill) db.run(sql.raw(s.replace(/;\s*$/, "")));
    const rows = listDecisionRows(owner.id);
    expect(rows.map((d) => [d.ref, d.question]).sort()).toEqual([
      ["D-1", "Turn off?"],
      ["D-2", "@x proposes: archive. dup"],
      ["D-3", "@devchief: Newer?"],
    ]);
    expect(rows.find((d) => d.ref === "D-1")).toMatchObject({ risk: ["device"], action: { label: "Confirm on House", href: "/house" } });
    expect(rows.find((d) => d.ref === "D-2")?.risk).toEqual(["destructive"]);
    expect(rows.find((d) => d.ref === "D-3")?.raisedBy).toBe("agent:devchief");
    expect(head()).toMatchObject({ question: "@devchief: Newer?", ref: "D-3", choices: ["Yes"], askedAt: "2026-11-07T10:00:00.000Z" });
    // Back-compat: the legacy answer route still works on migrated rows.
    store.answerDecision(owner, second, "Yes", cid);
    expect(rows.length).toBe(3);
    expect(row("D-1").state).toBe("answered");
    expect(head(second)).toBeNull();
  });
});

describe("MCP decision tools", () => {
  let token: string;
  let other: string;
  let n = 0;
  async function call(t: string, name: string, args: Record<string, unknown> = {}) {
    const res = await mcpRoute.POST(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary tool JSON
    return { isError: !!j.result.isError, value: JSON.parse(j.result.content[0]!.text) as Record<string, any> };
  }
  beforeEach(() => {
    __resetAgentRate();
    const scopes = ["work.read", "work.write", "decisions.write", "runs.write"] as const;
    token = mintAgentToken(owner, { name: "Chief", profile: "chiefofstaff", scopes: [...scopes] }, cid).token;
    other = mintAgentToken(owner, { name: "Dev", profile: "devchief", scopes: [...scopes] }, cid).token;
  });

  it("raise returns D-n with the context pack; risk + default is refused; old signature still works", async () => {
    const old = await call(token, "jarvis_raise_decision", { itemId, question: "Plain?", choices: ["Yes", "No"] });
    expect(old).toMatchObject({ isError: false, value: { ref: "D-1", state: "open" } });
    const rich = await call(token, "jarvis_raise_decision", {
      itemId,
      question: "Raise the Traefik limit?",
      choices: ["Raise to 64", "Keep 10"],
      recommended: "Raise to 64",
      pack: {
        why: "Chats fail with 429 under load",
        facts: [{ label: "Path", value: "/mnt/user/appdata/traefik-v3/fileConfig.yml" }],
        options: [{ choice: "Raise to 64", effect: "No more 429s" }],
        evidence: [{ kind: "diff", label: "fileConfig.yml", text: "- amount: 10\n+ amount: 64" }],
        unblocks: ["#247"],
      },
      defaultChoice: "Raise to 64",
      expiresAt: inMin(120),
    });
    expect(rich.value.ref).toBe("D-2");
    expect(row("D-2")).toMatchObject({ recommended: "Raise to 64", defaultChoice: "Raise to 64" });
    const bad = await call(token, "jarvis_raise_decision", {
      itemId,
      question: "Rotate the key?",
      choices: ["Rotate", "Keep"],
      risk: ["credential"],
      defaultChoice: "Rotate",
      expiresAt: inMin(120),
    });
    expect(bad).toMatchObject({ isError: true, value: { error: "default_risk" } });
    const listed = await call(token, "jarvis_list_decisions");
    expect(listed.value.decisions.map((d: { ref: string }) => d.ref)).toEqual(["D-2", "D-1"]);
  });

  it("agents supersede only their own decisions; there is no answer tool; the answer route is owner-only", async () => {
    await call(token, "jarvis_raise_decision", { itemId, question: "Old?", choices: ["Yes"] });
    expect((await call(other, "jarvis_supersede_decision", { ref: "D-1", reason: "mine now" })).value.error).toBe("not_yours");
    const sup = await call(token, "jarvis_supersede_decision", { ref: "D-1", reason: "changed", replacement: { question: "New?", choices: ["Yes"] } });
    expect(sup.value).toMatchObject({ superseded: "D-1", ref: "D-2" });
    const tools = await mcpRoute.POST(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const names = ((await tools.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("jarvis_supersede_decision");
    expect(names.some((x) => /answer/.test(x))).toBe(false);
    // An agent bearer token on the owner answer route is refused.
    const res = await answerRoute.POST(
      new NextRequest("http://localhost/api/coordinator/decisions/D-2/answer", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-jarvis-csrf": "1", origin: "http://localhost" },
        body: JSON.stringify({ answer: "Yes" }),
      }),
      { params: Promise.resolve({ ref: "D-2" }) },
    );
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
    expect(row("D-2").state).toBe("open");
    const answered = await call(token, "jarvis_list_decisions", { state: "all" });
    expect(answered.value.decisions.find((d: { ref: string }) => d.ref === "D-1").state).toBe("superseded");
  });
});
