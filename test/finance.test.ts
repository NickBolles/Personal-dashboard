/**
 * Finance module, server side: storage, routes, Monarch (mock), CSV,
 * matching, funds, plan, notifications and access. Synthetic figures only.
 */
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { startMockServer } from "../mock-upstreams/server.mjs";
import { __setTestDatabase, getDb, schema } from "@/server/db";
import { claimInstance, createSession } from "@/server/auth";
import { createPerson } from "@/server/people";
import { saveIntegration } from "@/integrations/store";
import { updatePreferences } from "@/server/settings";
import { createAccount, listAccounts, mapAccount, setExternalIgnored } from "@/server/finance/accounts";
import { saveFinanceSettings, thisMonth, today } from "@/server/finance/common";
import { addAction, closeCheckin, getCheckin, resnapshot, startCheckin, updateAction, setLeg, acknowledge } from "@/server/finance/checkins";
import { createFund, listHoldings, setHolding } from "@/server/finance/funds";
import { confirmMatch, enterBalances, finishRun, importCsv, proposeMatches, refreshFromMonarch, recentTransactions } from "@/server/finance/sync";
import { startRun } from "@/server/finance/runs";
import { addActual, assertLinkableEvent, createEvent, createRevision, ensureYear, getPlan, promoteRevision } from "@/server/finance/plan";
import { financeAdapter } from "@/integrations/finance/adapter";
import { adapterContext, getHome } from "@/server/sources";
import { buildContext } from "@/server/context";
import { userById } from "@/server/auth";
import { issueKey } from "@/lib/finance/types";

let server: Server;
let base: string;
let nick: string;
let cass: string;
let kid: string;
const $ = (d: number) => Math.round(d * 100);
const C = "test-corr";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, url: string, userId: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest(new URL(url, "http://jarvis.test"), {
    method,
    headers: { "content-type": "application/json", "x-jarvis-csrf": "1", cookie: `jarvis_session=${createSession(userId).token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  server = startMockServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JARVIS_MOCK_UPSTREAM_URL = base;
  __setTestDatabase();
  nick = claimInstance({ setupCode: "TESTCODE", name: "Nick", passcode: "secret123" });
  updatePreferences({ timezone: "America/Chicago", onboarding: { completedAt: new Date().toISOString() } });
  cass = createPerson({ name: "Cassidy", username: "cassidy", role: "adult", passcode: "cassidy-pass" }, nick).id;
  kid = createPerson({ name: "Ava", username: "ava", role: "kid", passcode: "avasecret1" }, nick).id;
});
afterAll(() => server?.close());

describe("access", () => {
  it("someone without finance access can't reach any financial endpoint", async () => {
    const root = path.join(process.cwd(), "app/api/finance");
    const files: string[] = [];
    const walk = (d: string) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "route.ts" && files.push(path.join(d, e.name))));
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const mod = (await import(f)) as Record<string, unknown>;
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (!mod[m]) continue;
        const r = await call(mod[m], "/api/finance/x?type=event&id=1", kid, m, m === "GET" || m === "DELETE" ? undefined : {}, { id: "x" });
        expect(r.status, `${m} ${path.relative(root, f)}`).toBe(403);
      }
    }
  });
});

describe("a month end-to-end with manual and CSV input only (AC-04)", () => {
  let chk: string, sav: string, visa: string, checkinId: string;

  it("sets up accounts, balances and the reserve", () => {
    chk = createAccount({ name: "Joint checking", kind: "checking", reserveAccount: true }, nick, C).id;
    sav = createAccount({ name: "Savings", kind: "savings" }, nick, C).id;
    visa = createAccount({ name: "Visa", kind: "credit_card", cardBasis: "current" }, nick, C).id;
    enterBalances(
      [
        { accountId: chk, balance: $(10_000) },
        { accountId: sav, balance: $(48_500) },
        { accountId: visa, balance: $(-1_500) },
      ],
      nick,
      C,
    );
    saveFinanceSettings({ cushion: $(2_000) }, nick, C);
    expect(listAccounts().map((a) => a.balance?.source)).toEqual(["manual", "manual", "manual"]);
  });

  it("plans a card payment from the suggestion, marks it done, and closes", () => {
    checkinId = startCheckin(thisMonth(), nick, C);
    expect(startCheckin(thisMonth(), cass, C)).toBe(checkinId);
    const suggestion = getCheckin(checkinId).result.suggestions.find((s) => s.accountId === visa)!;
    expect(suggestion).toMatchObject({ suggested: $(1_500), source: { kind: "checking", accountId: chk } });
    const a = addAction(
      checkinId,
      { kind: "card_payment", label: "Pay Visa", amount: suggestion.suggested, fromAccountId: chk, toAccountId: visa, date: today() },
      cass,
      C,
    );
    let c = getCheckin(checkinId);
    expect(c.result.suggestions.find((s) => s.accountId === visa)!.suggested).toBe(0);
    expect(c.result.change.net).toBe(0);
    expect(c.result.ending.liquid).toBe(c.result.starting.liquid - $(1_500));
    updateAction(a, { status: "settled", note: "after paycheck", version: c.actions[0]!.version }, cass, C);
    c = getCheckin(checkinId);
    expect(c.actions[0]).toMatchObject({ status: "settled", doneBy: cass });
    // Stale-version edits are refused.
    expect(() => updateAction(a, { label: "x", version: 1 }, nick, C)).toThrow(/changed this just now/);
    // Warnings (none here besides maybe unknown as-of) must be acknowledged; there are no blocking ones.
    expect(c.result.blocking).toBe(0);
    for (const i of c.result.issues) acknowledge(checkinId, issueKey(i), "ok", nick, C);
    c = getCheckin(checkinId);
    closeCheckin(checkinId, c.version, "September done", nick, C);
    expect(getCheckin(checkinId).status).toBe("closed");
  });

  it("a closed check-in is immutable (AC-19)", () => {
    expect(() => addAction(checkinId, { kind: "external_outflow", label: "late", amount: 100, fromAccountId: chk, date: today() }, nick, C)).toThrow(/closed/);
    expect(() => resnapshot(checkinId, getCheckin(checkinId).version, nick, C)).toThrow(/closed/);
  });

  it("unbalanced rows block close and can't be acknowledged (AC-10)", () => {
    const id = startCheckin("2099-01", nick, C);
    const a = addAction(id, { kind: "transfer", label: "Move", amount: $(10), fromAccountId: sav, toAccountId: null, date: today() }, nick, C);
    const issue = getCheckin(id).result.issues.find((i) => i.code === "row_unbalanced")!;
    expect(() => acknowledge(id, issueKey(issue), "fine", nick, C)).toThrow(/can't be acknowledged/);
    expect(() => closeCheckin(id, getCheckin(id).version, undefined, nick, C)).toThrow(/must be fixed/);
    expect(a).toBeTruthy();
  });

  it("a running refresh blocks snapshot and close (no silent race)", () => {
    const id = startCheckin("2099-02", nick, C);
    const run = startRun("csv", nick);
    expect(() => resnapshot(id, getCheckin(id).version, nick, C)).toThrow(/refresh is running/);
    expect(() => closeCheckin(id, getCheckin(id).version, undefined, nick, C)).toThrow(/refresh is running/);
    expect(() => startRun("monarch", nick)).toThrow(/already running/);
    finishRun(run, "succeeded");
  });

  it("a newer balance puts done legs back to unknown until someone confirms", () => {
    const id = startCheckin("2099-03", nick, C);
    const a = addAction(id, { kind: "external_outflow", label: "Tuition", amount: $(500), fromAccountId: chk, date: today() }, nick, C);
    updateAction(a, { status: "settled", version: 1 }, nick, C);
    enterBalances([{ accountId: chk, balance: $(9_500) }], nick, C);
    resnapshot(id, getCheckin(id).version, nick, C);
    const c = getCheckin(id);
    expect(c.actions[0]!.legs[0]!.inclusion).toBe("unknown");
    expect(c.result.issues.map((i) => i.code)).toContain("inclusion_unknown");
    expect(() => setLeg(a, "source", "included", "", nick, C)).toThrow(/how you know/);
    setLeg(a, "source", "included", "Checking shows it on the 2nd", nick, C);
    expect(getCheckin(id).result.issues.map((i) => i.code)).not.toContain("inclusion_unknown");
  });
});

describe("CSV import", () => {
  it("identical rows stay distinct, re-import adds nothing, overlap with another source is flagged", () => {
    const acct = createAccount({ name: "CSV checking", kind: "checking" }, nick, C).id;
    const csv = "date,amount,description\n2026-09-02,-4.50,COFFEE\n2026-09-02,-4.50,COFFEE\n2026-09-03,-20.00,GAS\n";
    expect(importCsv("transactions", csv, acct, nick, C)).toMatchObject({ imported: 3, errors: [] });
    expect(importCsv("transactions", csv, acct, nick, C)).toMatchObject({ imported: 0 });
    getDb()
      .insert(schema.finTransactions)
      .values({ id: "ftx_other", accountId: acct, source: "monarch", sourceTxnId: "m-9", date: "2026-09-05", amount: -999, description: "THING" })
      .run();
    const r = importCsv("transactions", "date,amount,description\n9/5/2026,(9.99),Thing\n", acct, nick, C);
    expect(r.ambiguous).toBe(1);
    expect(r.outcome).toBe("attention");
  });

  it("balance CSV keeps the as-of it was given, or unknown", () => {
    const acct = createAccount({ name: "Brokerage cash", kind: "savings" }, nick, C);
    importCsv("balances", 'account,balance,as_of\nBrokerage cash,"1,234.56",\n', undefined, nick, C);
    const b = listAccounts().find((a) => a.id === acct.id)!.balance!;
    expect(b).toMatchObject({ balance: 123456, source: "csv", asOf: null });
  });
});

describe("Monarch (mock)", () => {
  it("refreshes, lists provider records, and stores provider as-of times", async () => {
    saveIntegration("finance", {
      enabled: true,
      config: { balanceSource: "monarch", monarchUrl: `${base}/monarch`, refreshWaitSeconds: 2 },
      secrets: { monarchToken: "mock-monarch-session-token" },
    });
    const first = await refreshFromMonarch(nick, C);
    expect(first.outcome).toBe("attention"); // nothing mapped yet: partial, said plainly
    const ext = getDb().select().from(schema.finExternalAccounts).all();
    expect(ext.map((e) => e.externalId).sort()).toEqual(["m-chk", "m-sav", "m-store-1", "m-store-2", "m-visa"]);
    // Data minimization: no institution or mask columns exist at all.
    expect(Object.keys(ext[0]!)).not.toEqual(expect.arrayContaining(["institution", "mask"]));
  });

  it("one provider record can't feed two accounts; a duplicate can be set aside (AC-28)", () => {
    const a = createAccount({ name: "Store card", kind: "credit_card", cardBasis: "current" }, nick, C);
    const b = createAccount({ name: "Store card (old)", kind: "credit_card", cardBasis: "current" }, nick, C);
    mapAccount(a.id, { source: "monarch", externalId: "m-store-1" }, a.version, nick, C);
    expect(() => mapAccount(b.id, { source: "monarch", externalId: "m-store-1" }, b.version, nick, C)).toThrow(/already feeds/);
    setExternalIgnored("monarch", "m-store-2", true, nick, C);
    expect(() => mapAccount(b.id, { source: "monarch", externalId: "m-store-2" }, b.version, nick, C)).toThrow(/duplicate/);
  });

  it("mapped balances come in signed, with Monarch's as-of, and transactions are importable", async () => {
    const chk = createAccount({ name: "M checking", kind: "checking" }, nick, C);
    const visa = createAccount({ name: "M visa", kind: "credit_card", cardBasis: "current" }, nick, C);
    mapAccount(chk.id, { source: "monarch", externalId: "m-chk" }, chk.version, nick, C);
    mapAccount(visa.id, { source: "monarch", externalId: "m-visa" }, visa.version, nick, C);
    const r = await refreshFromMonarch(nick, C);
    expect(r.stored).toBe(3);
    const accts = listAccounts();
    expect(accts.find((a) => a.id === visa.id)!.balance).toMatchObject({ balance: $(-1_500), source: "monarch" });
    expect(accts.find((a) => a.id === chk.id)!.balance!.asOf).not.toBeNull();
    expect(
      recentTransactions("2000-01-01")
        .filter((t) => t.source === "monarch" && t.accountId === visa.id)
        .map((t) => t.pending),
    ).toEqual(expect.arrayContaining([true, false]));
  });

  it("matching: proposals need confirmation; pending is never posted; one transaction can't pay twice", () => {
    const accts = listAccounts();
    const chk = accts.find((a) => a.name === "M checking")!;
    const visa = accts.find((a) => a.name === "M visa")!;
    const id = startCheckin("2099-04", nick, C);
    const pay = addAction(
      id,
      { kind: "card_payment", label: "Pay M visa", amount: $(1_500), fromAccountId: chk.id, toAccountId: visa.id, date: today() },
      nick,
      C,
    );
    const dup = addAction(
      id,
      { kind: "card_payment", label: "Pay M visa again", amount: $(1_500), fromAccountId: chk.id, toAccountId: visa.id, date: today() },
      nick,
      C,
    );
    const proposals = proposeMatches(id).filter((p) => p.actionId === pay);
    expect(proposals.map((p) => p.side).sort()).toEqual(["destination", "source"]);
    const src = proposals.find((p) => p.side === "source")!;
    confirmMatch({ transactionId: src.transactionId, actionId: pay, side: "source", inclusion: "included" }, nick, C);
    expect(getCheckin(id).actions.find((a) => a.id === pay)!.status).toBe("initiated");
    expect(() => confirmMatch({ transactionId: src.transactionId, actionId: dup, side: "source", inclusion: "included" }, nick, C)).toThrow(/can't pay twice/);
    const pending = recentTransactions("2000-01-01").find((t) => t.pending && t.accountId === visa.id)!;
    const out = addAction(id, { kind: "external_outflow", label: "Groceries", amount: -pending.amount, fromAccountId: visa.id, date: today() }, nick, C);
    expect(() => confirmMatch({ transactionId: pending.id, actionId: out, side: "source", inclusion: "included" }, nick, C)).toThrow(/available/);
    confirmMatch({ transactionId: pending.id, actionId: out, side: "source", inclusion: "excluded" }, nick, C);
    expect(getCheckin(id).actions.find((a) => a.id === out)!.status).toBe("planned");
  });

  it("an unreachable Monarch fails the run and says so", async () => {
    await fetch(`${base}/__mock/fail`, { method: "POST", body: JSON.stringify({ services: ["monarch"] }), headers: { "content-type": "application/json" } });
    await expect(refreshFromMonarch(nick, C)).rejects.toThrow();
    const run = getDb().select().from(schema.finRuns).all().at(-1)!;
    expect(run).toMatchObject({ status: "failed", outcome: "failed" });
    await fetch(`${base}/__mock/fail`, { method: "POST", body: JSON.stringify({ restore: ["monarch"] }), headers: { "content-type": "application/json" } });
  });
});

describe("notifications", () => {
  it("go to everyone who can see finances, carry no amounts or names, and never duplicate", () => {
    const run = startRun("csv", nick);
    finishRun(run, "succeeded");
    finishRun(run, "succeeded"); // crash-recovered retry
    const rows = getDb()
      .select()
      .from(schema.notifications)
      .all()
      .filter((n) => n.dedupeKey?.startsWith(`finance:run:${run}:`));
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([nick, cass]));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(`${r.title} ${r.body}`).not.toMatch(/\d{2,}|\$|Visa|checking|savings|Monarch/i);
      // Opt-in: push stays off until someone turns the finance category on.
      expect(r.pushState).toBeNull();
    }
  });

  it("push only for people who opted in", () => {
    updatePreferences({ notificationCategories: { finance: { push: true } } }, cass);
    const run = startRun("csv", nick);
    finishRun(run, "failed", "boom");
    const rows = getDb()
      .select()
      .from(schema.notifications)
      .all()
      .filter((n) => n.dedupeKey === `finance:run:${run}:failed`);
    expect(rows.find((r) => r.userId === cass)!.pushState).toBe("pending");
    expect(rows.find((r) => r.userId === nick)!.pushState).toBeNull();
    expect(rows[0]!.title).toBe("Balance refresh failed");
  });
});

describe("funds", () => {
  it("a fund is drawn exactly once per done action, wherever it's held; undo puts it back", () => {
    const chk = listAccounts().find((a) => a.name === "Joint checking")!;
    const sav = listAccounts().find((a) => a.name === "Savings")!;
    const travel = createFund({ name: "Travel" }, nick, C);
    setHolding(travel, sav.id, $(4_000), null, nick, C);
    const id = startCheckin("2099-05", nick, C);
    const a = addAction(id, { kind: "external_outflow", label: "Flights", amount: $(3_000), fromAccountId: chk.id, fundId: travel, date: today() }, nick, C);
    const held = () => listHoldings().find((h) => h.fundId === travel && h.accountId === sav.id)!.amount;
    updateAction(a, { status: "settled", version: 1 }, nick, C);
    expect(held()).toBe($(1_000));
    // Saving again (e.g. a note) doesn't draw again.
    updateAction(a, { note: "booked", version: 2 }, nick, C);
    expect(held()).toBe($(1_000));
    updateAction(a, { status: "planned", version: 3 }, nick, C);
    expect(held()).toBe($(4_000));
    updateAction(a, { status: "settled", version: 4 }, nick, C);
    expect(held()).toBe($(1_000));
    const f = getCheckin(id).result.funds.find((x) => x.fundId === travel)!;
    expect(f).toMatchObject({ held: $(1_000), reserved: 0, available: $(1_000) });
  });
});

describe("long-term plan", () => {
  it("promotion keeps actuals; hypothetical revisions never feed check-ins", () => {
    const year = 2098;
    const r1 = ensureYear(year, nick, C);
    const tax = createFund({ name: "Tax" }, nick, C);
    const ev = createEvent(r1, { label: "Q3 tax", kind: "obligation", date: `${year}-09-15`, amount: $(-8_000), allocations: { [tax]: $(-8_000) } }, nick, C);
    addActual(ev, { date: `${year}-09-14`, amount: $(-8_200), allocations: [{ fundId: tax, amount: $(-8_000) }], complete: true }, nick, C);
    const r2 = createRevision(year, { name: "What if", changeNote: "Try a lower estimate" }, nick, C);
    const hypo = createEvent(r2, { label: "Boat", kind: "obligation", date: `${year}-10-01`, amount: $(-1_000), allocations: {} }, nick, C);
    expect(() => assertLinkableEvent(hypo)).toThrow(/active plan/);
    assertLinkableEvent(ev);
    expect(() => createRevision(year, { name: "x", changeNote: " " }, nick, C)).toThrow(/why/);
    const before = getPlan(year, r1, "actual").result;
    promoteRevision(r2, 1, nick, C);
    const after = getPlan(year, r2, "actual").result;
    expect(after.rows).toEqual(before.rows);
    expect(getPlan(year, undefined, "forecast").revision.id).toBe(r2);
    expect(getPlan(year, r1, "plan").revision).toMatchObject({ kind: "archived", editable: false });
    expect(() => createEvent(r1, { label: "x", kind: "income", date: `${year}-01-01`, amount: 1, allocations: {} }, nick, C)).toThrow(/read-only/);
    // The actual's -200 discrepancy stays visible until an audited correction.
    expect(getPlan(year, r2, "forecast").result.rows.find((r) => r.eventId === ev)!.unallocated).toBe($(-200));
  });
});

describe("Home", () => {
  it("finance cards show for people with finance access, without amounts", async () => {
    const ctx = adapterContext();
    const data = await financeAdapter.fetch(ctx);
    expect(data.actions.length).toBeGreaterThan(0);
    for (const a of data.actions) expect(`${a.title} ${a.detail ?? ""}`).not.toMatch(/\$|\d{3,}/);
    const kidRows = getDb()
      .select()
      .from(schema.userCapabilities)
      .where(and(eq(schema.userCapabilities.userId, kid), eq(schema.userCapabilities.capability, "finance.view")))
      .all();
    expect(kidRows).toEqual([]);
  });

  it("finance cards never reach the AI layer, even in the overview", async () => {
    const me = userById(nick)!;
    const home = await getHome(me, { live: true });
    expect([...home.now, ...home.later.laterToday, ...home.later.upcoming].some((a) => a.source === "finance")).toBe(true);
    const overview = await buildContext(me, ["overview"], undefined);
    expect(overview).not.toMatch(/\[finance:|check-in|Finance/);
  });
});
