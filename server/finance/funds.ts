import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { addDays, allocateFundDraw } from "@/lib/finance/engine";
import type { Cents, Fund, FundHolding, ScheduledFlow } from "@/lib/finance/types";
import { auditFinance, notFound, updateVersioned } from "./common";

export function listFunds(includeArchived = false): (Fund & { version: number })[] {
  return getDb()
    .select()
    .from(schema.finFunds)
    .orderBy(asc(schema.finFunds.position), asc(schema.finFunds.name))
    .all()
    .filter((f) => includeArchived || !f.archived)
    .map((f) => ({ id: f.id, name: f.name, protected: f.protected, archived: f.archived, version: f.version }));
}

export function listHoldings(): (FundHolding & { version: number })[] {
  return getDb()
    .select()
    .from(schema.finFundHoldings)
    .all()
    .map((h) => ({ fundId: h.fundId, accountId: h.accountId, amount: h.amount, version: h.version }));
}

export function createFund(input: { name: string; protected?: boolean }, actor: string, correlationId: string) {
  const id = newId("ffd");
  const position = getDb().select().from(schema.finFunds).all().length;
  getDb()
    .insert(schema.finFunds)
    .values({ id, name: input.name.trim(), protected: Boolean(input.protected), position })
    .run();
  auditFinance(actor, "finance.fund.create", id, null, input, correlationId);
  return id;
}

export function updateFund(
  id: string,
  patch: { name?: string; protected?: boolean; archived?: boolean; version: number },
  actor: string,
  correlationId: string,
) {
  const before = getDb().select().from(schema.finFunds).where(eq(schema.finFunds.id, id)).get() ?? notFound("Fund");
  const { version, ...set } = patch;
  updateVersioned(schema.finFunds, eq(schema.finFunds.id, id), version, set);
  auditFinance(actor, "finance.fund.update", id, before, set, correlationId);
}

/**
 * Set how much of an account is earmarked for a fund (an allocation, not a
 * transfer). Recorded as a movement so history explains every change.
 */
export function setHolding(fundId: string, accountId: string, amount: Cents, version: number | null, actor: string, correlationId: string) {
  if (!Number.isInteger(amount) || amount < 0) throw new HttpError(400, "bad_amount", "Earmarks are zero or more, in whole cents.");
  const db = getDb();
  db.transaction((tx) => {
    const cur = tx
      .select()
      .from(schema.finFundHoldings)
      .where(and(eq(schema.finFundHoldings.fundId, fundId), eq(schema.finFundHoldings.accountId, accountId)))
      .get();
    if (cur) {
      if (version === null) throw new HttpError(409, "version_conflict", "This earmark already exists. Reload and try again.");
      updateVersioned(
        schema.finFundHoldings,
        and(eq(schema.finFundHoldings.fundId, fundId), eq(schema.finFundHoldings.accountId, accountId))!,
        version,
        { amount },
        tx as unknown as DB,
      );
    } else {
      tx.insert(schema.finFundHoldings).values({ fundId, accountId, amount }).run();
    }
    tx.insert(schema.finFundMovements)
      .values({ id: newId("ffm"), fundId, accountId, kind: "set", amount: amount - (cur?.amount ?? 0), createdBy: actor, note: "Earmark changed" })
      .run();
    auditFinance(actor, "finance.fund.holding", `${fundId}:${accountId}`, cur?.amount ?? null, amount, correlationId);
  });
}

function cycleFor(tx: DB, actionId: string) {
  const r = tx
    .select({ n: sql<number>`count(*)` })
    .from(schema.finFundMovements)
    .where(and(eq(schema.finFundMovements.actionId, actionId), eq(schema.finFundMovements.kind, "release")))
    .get();
  return Number(r?.n ?? 0);
}

function consumedNow(rows: (typeof schema.finFundMovements.$inferSelect)[]) {
  const cycles = new Set(rows.filter((r) => r.kind === "consume").map((r) => r.cycle));
  const released = new Set(rows.filter((r) => r.kind === "release").map((r) => r.cycle));
  return [...cycles].some((c) => !released.has(c));
}

/** Actions whose fund draw is persisted (the engine must not reserve them again). */
export function consumedActionIds(): string[] {
  const rows = getDb()
    .select()
    .from(schema.finFundMovements)
    .where(sql`${schema.finFundMovements.actionId} is not null`)
    .all();
  const by = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) by.set(r.actionId!, [...(by.get(r.actionId!) ?? []), r]);
  return [...by].filter(([, rs]) => consumedNow(rs)).map(([id]) => id);
}

/**
 * When a fund-tagged action is done, draw the fund (from wherever it's held,
 * independent of the pay-from account). Exactly once per cycle: the unique
 * index makes a retried or concurrent settle a no-op.
 */
export function consumeForAction(tx: DB, a: { id: string; fundId: string | null; amount: Cents; fromAccountId: string | null }, actor: string) {
  if (!a.fundId) return;
  const rows = tx.select().from(schema.finFundMovements).where(eq(schema.finFundMovements.actionId, a.id)).all();
  if (consumedNow(rows)) return;
  const cycle = cycleFor(tx, a.id);
  const holdings = tx.select().from(schema.finFundHoldings).where(eq(schema.finFundHoldings.fundId, a.fundId)).all();
  const { draws, shortfall } = allocateFundDraw(a.fundId, Math.abs(a.amount), a.fromAccountId, holdings);
  if (shortfall > 0) throw new HttpError(409, "fund_overdrawn", "The fund doesn't hold enough for this. Adjust the earmark or the action first.");
  for (const d of draws) {
    tx.insert(schema.finFundMovements)
      .values({ id: newId("ffm"), fundId: a.fundId, accountId: d.accountId, kind: "consume", amount: -d.amount, actionId: a.id, cycle, createdBy: actor })
      .onConflictDoNothing()
      .run();
    tx.update(schema.finFundHoldings)
      .set({ amount: sql`${schema.finFundHoldings.amount} - ${d.amount}`, version: sql`${schema.finFundHoldings.version} + 1` })
      .where(and(eq(schema.finFundHoldings.fundId, a.fundId), eq(schema.finFundHoldings.accountId, d.accountId)))
      .run();
  }
}

/** Undo a draw (action reopened or deleted): put the earmarks back. */
export function releaseForAction(tx: DB, actionId: string, actor: string) {
  const rows = tx.select().from(schema.finFundMovements).where(eq(schema.finFundMovements.actionId, actionId)).all();
  if (!consumedNow(rows)) return;
  const cycle = cycleFor(tx, actionId);
  for (const r of rows.filter((x) => x.kind === "consume" && x.cycle === cycle)) {
    tx.insert(schema.finFundMovements)
      .values({ id: newId("ffm"), fundId: r.fundId, accountId: r.accountId, kind: "release", amount: -r.amount, actionId, cycle, createdBy: actor })
      .run();
    tx.update(schema.finFundHoldings)
      .set({ amount: sql`${schema.finFundHoldings.amount} + ${-r.amount}`, version: sql`${schema.finFundHoldings.version} + 1` })
      .where(and(eq(schema.finFundHoldings.fundId, r.fundId), eq(schema.finFundHoldings.accountId, r.accountId)))
      .run();
  }
}

/* ---------------------------------------------------------- reserve flows */

export type FlowRow = typeof schema.finFlows.$inferSelect;

export function listFlows(): FlowRow[] {
  return getDb().select().from(schema.finFlows).orderBy(asc(schema.finFlows.date)).all();
}

export type FlowInput = {
  label: string;
  accountId: string;
  amount: Cents;
  date: string;
  recurrence?: "none" | "weekly" | "biweekly" | "monthly" | "yearly";
  reliable?: boolean;
  fundId?: string | null;
};

export function createFlow(input: FlowInput, actor: string, correlationId: string) {
  const id = newId("ffl");
  getDb()
    .insert(schema.finFlows)
    .values({ id, ...input, label: input.label.trim(), recurrence: input.recurrence ?? "none", reliable: input.amount > 0 && Boolean(input.reliable) })
    .run();
  auditFinance(actor, "finance.flow.create", id, null, input, correlationId);
  return id;
}

export function updateFlow(id: string, patch: Partial<FlowInput> & { active?: boolean; version: number }, actor: string, correlationId: string) {
  const before = getDb().select().from(schema.finFlows).where(eq(schema.finFlows.id, id)).get() ?? notFound("Scheduled item");
  const { version, ...set } = patch;
  updateVersioned(schema.finFlows, eq(schema.finFlows.id, id), version, set);
  auditFinance(actor, "finance.flow.update", id, before, set, correlationId);
}

export function deleteFlow(id: string, actor: string, correlationId: string) {
  const before = getDb().select().from(schema.finFlows).where(eq(schema.finFlows.id, id)).get() ?? notFound("Scheduled item");
  getDb().delete(schema.finFlows).where(eq(schema.finFlows.id, id)).run();
  auditFinance(actor, "finance.flow.delete", id, before, null, correlationId);
}

function step(date: string, recurrence: string) {
  const d = new Date(`${date}T00:00:00Z`);
  if (recurrence === "weekly") return addDays(date, 7);
  if (recurrence === "biweekly") return addDays(date, 14);
  if (recurrence === "monthly") {
    const day = d.getUTCDate();
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, last));
    return next.toISOString().slice(0, 10);
  }
  if (recurrence === "yearly") return `${d.getUTCFullYear() + 1}${date.slice(4)}`;
  return null;
}

/**
 * Occurrences inside [from, to]. Each occurrence has a stable id
 * (`flowId@date`) so a check-in action can say which one it covers.
 */
export function expandFlows(flows: FlowRow[], from: string, to: string): ScheduledFlow[] {
  const out: ScheduledFlow[] = [];
  for (const f of flows.filter((x) => x.active)) {
    let date: string | null = f.date;
    for (let i = 0; date && date <= to && i < 400; i++) {
      if (date >= from) {
        out.push({ id: `${f.id}@${date}`, label: f.label, accountId: f.accountId, amount: f.amount, date, reliable: f.reliable, fundId: f.fundId });
      }
      date = f.recurrence === "none" ? null : step(date, f.recurrence);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
