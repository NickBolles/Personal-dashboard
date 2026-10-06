import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { addDays, computeCheckin, legEffects, type CheckinInput, type CheckinResult } from "@/lib/finance/engine";
import {
  issueKey,
  type ActionKind,
  type ActionLeg,
  type ActionStatus,
  type CardBasis,
  type Cents,
  type FinAction,
  type Inclusion,
  type LegSide,
} from "@/lib/finance/types";
import { accountRows, latestBalance, toAccount, toSnapshot } from "./accounts";
import { auditFinance, financeSettings, notFound, thisMonth, today, updateVersioned } from "./common";
import { consumeForAction, consumedActionIds, expandFlows, listFlows, listFunds, listHoldings, releaseForAction } from "./funds";
import { runningRun } from "./runs";

type CheckinRow = typeof schema.finCheckins.$inferSelect;
type ActionRow = typeof schema.finActions.$inferSelect;
type LegRow = typeof schema.finActionLegs.$inferSelect;

export type Acknowledgement = { key: string; by: string; at: string; note?: string };

export type ActionView = FinAction & {
  version: number;
  planEventId: string | null;
  doneAt: string | null;
  doneBy: string | null;
  carriedFromId: string | null;
  createdBy: string;
  legDetails: (ActionLeg & { confirmedBy: string | null; confirmedAt: string | null })[];
};

export type CheckinView = {
  id: string;
  month: string;
  status: "draft" | "closed";
  version: number;
  snapshotAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  acknowledged: Acknowledgement[];
  actions: ActionView[];
  result: CheckinResult;
  refreshRunning: boolean;
};

const db = () => getDb();

export function getCheckinRow(id: string) {
  return db().select().from(schema.finCheckins).where(eq(schema.finCheckins.id, id)).get() ?? notFound("Check-in");
}

export function listCheckins() {
  return db().select().from(schema.finCheckins).orderBy(desc(schema.finCheckins.month)).all();
}

function assertDraft(c: CheckinRow) {
  if (c.status !== "draft")
    throw new HttpError(409, "closed", "This check-in is closed and can't change. Record a correction as an adjustment in a later check-in.");
}

function toAction(r: ActionRow, legs: LegRow[]): ActionView {
  const mine = legs.filter((l) => l.actionId === r.id);
  return {
    id: r.id,
    kind: r.kind as ActionKind,
    label: r.label,
    amount: r.amount,
    fromAccountId: r.fromAccountId,
    toAccountId: r.toAccountId,
    date: r.date,
    status: r.status as ActionStatus,
    legs: mine.map((l) => ({
      side: l.side as LegSide,
      accountId: l.accountId,
      inclusion: l.inclusion as Inclusion,
      evidence: l.evidence,
      transactionId: l.transactionId,
    })),
    fundId: r.fundId,
    fundDecision: r.fundDecision,
    flowId: r.flowId,
    cardBasis: r.cardBasis as CardBasis | null,
    note: r.note,
    position: r.position,
    version: r.version,
    planEventId: r.planEventId,
    doneAt: r.doneAt,
    doneBy: r.doneBy,
    carriedFromId: r.carriedFromId,
    createdBy: r.createdBy,
    legDetails: mine.map((l) => ({
      side: l.side as LegSide,
      accountId: l.accountId,
      inclusion: l.inclusion as Inclusion,
      evidence: l.evidence,
      transactionId: l.transactionId,
      confirmedBy: l.confirmedBy,
      confirmedAt: l.confirmedAt,
    })),
  };
}

export function checkinActions(checkinId: string): ActionView[] {
  const rows = db().select().from(schema.finActions).where(eq(schema.finActions.checkinId, checkinId)).orderBy(asc(schema.finActions.position)).all();
  const legs = rows.length
    ? db()
        .select()
        .from(schema.finActionLegs)
        .where(
          inArray(
            schema.finActionLegs.actionId,
            rows.map((r) => r.id),
          ),
        )
        .all()
    : [];
  return rows.map((r) => toAction(r, legs));
}

function acknowledgements(c: CheckinRow): Acknowledgement[] {
  try {
    return JSON.parse(c.acknowledged) as Acknowledgement[];
  } catch {
    return [];
  }
}

export function unmatchedTransactionCount(since: string) {
  const r = db()
    .select({ n: sql<number>`count(*)` })
    .from(schema.finTransactions)
    .where(
      and(
        isNull(schema.finTransactions.supersededBy),
        sql`${schema.finTransactions.date} >= ${since}`,
        sql`not exists (select 1 from fin_action_legs l where l.transaction_id = ${schema.finTransactions.id})`,
        eq(schema.finTransactions.pending, false),
      ),
    )
    .get();
  return Number(r?.n ?? 0);
}

/** Everything the engine needs for one check-in. */
export function checkinInput(c: CheckinRow, now = new Date()): CheckinInput {
  const settings = financeSettings();
  const bindings = db().select().from(schema.finCheckinBalances).where(eq(schema.finCheckinBalances.checkinId, c.id)).all();
  const balances = bindings.length
    ? db()
        .select()
        .from(schema.finBalances)
        .where(
          inArray(
            schema.finBalances.id,
            bindings.map((b) => b.balanceId),
          ),
        )
        .all()
        .map(toSnapshot)
    : [];
  const t = today(now);
  const lastClosed = db()
    .select()
    .from(schema.finCheckins)
    .where(and(eq(schema.finCheckins.status, "closed"), sql`${schema.finCheckins.month} < ${c.month}`))
    .orderBy(desc(schema.finCheckins.month))
    .limit(1)
    .get();
  return {
    today: t,
    now: now.toISOString(),
    accounts: accountRows(true).map(toAccount),
    balances,
    actions: checkinActions(c.id),
    funds: listFunds(true),
    holdings: listHoldings(),
    consumedActionIds: consumedActionIds(),
    flows: expandFlows(listFlows(), t, addDays(t, settings.horizonDays)),
    settings,
    refreshRunning: Boolean(runningRun(now)),
    unmatchedTransactions: unmatchedTransactionCount(lastClosed?.closedAt?.slice(0, 10) ?? addDays(t, -45)),
    acknowledged: acknowledgements(c).map((a) => a.key),
  };
}

export function getCheckin(id: string, now = new Date()): CheckinView {
  const c = getCheckinRow(id);
  const actions = checkinActions(id);
  const result: CheckinResult = c.status === "closed" && c.summary ? (JSON.parse(c.summary) as CheckinResult) : computeCheckin(checkinInput(c, now));
  return {
    id: c.id,
    month: c.month,
    status: c.status as CheckinView["status"],
    version: c.version,
    snapshotAt: c.snapshotAt,
    closedAt: c.closedAt,
    closedBy: c.closedBy,
    closeNote: c.closeNote,
    acknowledged: acknowledgements(c),
    actions,
    result,
    refreshRunning: Boolean(runningRun(now)),
  };
}

/**
 * Bind the latest balance of every account to the check-in. Legs of actions
 * already marked done whose account balance changed go back to "unknown":
 * a newer balance may or may not include them, and only evidence decides.
 */
function snapshotInto(tx: DB, checkinId: string, actor: string) {
  const prev = new Map(
    tx
      .select()
      .from(schema.finCheckinBalances)
      .where(eq(schema.finCheckinBalances.checkinId, checkinId))
      .all()
      .map((b) => [b.accountId, b.balanceId]),
  );
  const changed = new Set<string>();
  for (const a of accountRows()) {
    const b = latestBalance(a.id);
    if (!b) continue;
    if (prev.get(a.id) !== b.id) changed.add(a.id);
    tx.insert(schema.finCheckinBalances)
      .values({ checkinId, accountId: a.id, balanceId: b.id })
      .onConflictDoUpdate({ target: [schema.finCheckinBalances.checkinId, schema.finCheckinBalances.accountId], set: { balanceId: b.id } })
      .run();
  }
  const done = tx
    .select()
    .from(schema.finActions)
    .where(and(eq(schema.finActions.checkinId, checkinId), inArray(schema.finActions.status, ["initiated", "settled"])))
    .all();
  for (const a of done) {
    tx.update(schema.finActionLegs)
      .set({
        inclusion: "unknown",
        evidence: "A newer balance arrived after this was done. Confirm whether it's included.",
        confirmedBy: null,
        confirmedAt: null,
      })
      .where(
        and(
          eq(schema.finActionLegs.actionId, a.id),
          eq(schema.finActionLegs.inclusion, "excluded"),
          inArray(schema.finActionLegs.accountId, [...changed].length ? [...changed] : ["-"]),
        ),
      )
      .run();
  }
  tx.update(schema.finCheckins)
    .set({ snapshotAt: new Date().toISOString(), version: sql`${schema.finCheckins.version} + 1` })
    .where(eq(schema.finCheckins.id, checkinId))
    .run();
  return { changed: [...changed], actor };
}

/** Start (or open) the check-in for a month, carrying forward open actions from the last closed one. */
export function startCheckin(month: string, actor: string, correlationId: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "bad_month", "Month must be YYYY-MM");
  const existing = db().select().from(schema.finCheckins).where(eq(schema.finCheckins.month, month)).get();
  if (existing) return existing.id;
  if (runningRun()) throw new HttpError(409, "refresh_running", "A balance refresh is running. Start the check-in when it finishes.");
  const id = newId("fci");
  db().transaction((tx) => {
    tx.insert(schema.finCheckins).values({ id, month, createdBy: actor }).run();
    const last = tx
      .select()
      .from(schema.finCheckins)
      .where(and(eq(schema.finCheckins.status, "closed"), sql`${schema.finCheckins.month} < ${month}`))
      .orderBy(desc(schema.finCheckins.month))
      .limit(1)
      .get();
    if (last) {
      const open = checkinActions(last.id).filter((a) => a.status === "planned" || a.status === "initiated");
      open.forEach((a, i) => {
        const nid = newId("fat");
        tx.insert(schema.finActions)
          .values({
            id: nid,
            checkinId: id,
            kind: a.kind,
            label: a.label,
            amount: a.amount,
            fromAccountId: a.fromAccountId,
            toAccountId: a.toAccountId,
            date: a.date,
            status: a.status,
            fundId: a.fundId,
            fundDecision: Boolean(a.fundDecision),
            flowId: a.flowId,
            cardBasis: a.cardBasis,
            planEventId: a.planEventId,
            note: a.note,
            position: i,
            carriedFromId: a.id,
            createdBy: actor,
          })
          .run();
        for (const l of a.legDetails) {
          // Included before stays included (balances are cumulative); anything else needs a fresh look.
          const inclusion: Inclusion = l.inclusion === "included" ? "included" : a.status === "planned" ? "excluded" : "unknown";
          tx.insert(schema.finActionLegs)
            .values({
              actionId: nid,
              side: l.side,
              accountId: l.accountId,
              inclusion,
              evidence: inclusion === "unknown" ? "Carried from last month: confirm against the new balances." : l.evidence,
              transactionId: null,
            })
            .run();
        }
      });
    }
    snapshotInto(tx as unknown as DB, id, actor);
  });
  auditFinance(actor, "finance.checkin.start", id, null, { month }, correlationId);
  return id;
}

export function resnapshot(id: string, version: number, actor: string, correlationId: string) {
  const c = getCheckinRow(id);
  assertDraft(c);
  if (c.version !== version) throw new HttpError(409, "version_conflict", "This check-in changed. Reload and try again.");
  if (runningRun()) throw new HttpError(409, "refresh_running", "A balance refresh is running. Take the snapshot when it finishes.");
  const r = db().transaction((tx) => snapshotInto(tx as unknown as DB, id, actor));
  auditFinance(actor, "finance.checkin.snapshot", id, null, { changedAccounts: r.changed.length }, correlationId);
}

export type ActionInput = {
  kind: ActionKind;
  label: string;
  amount: Cents;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  date?: string | null;
  fundId?: string | null;
  fundDecision?: boolean;
  flowId?: string | null;
  cardBasis?: CardBasis | null;
  planEventId?: string | null;
  note?: string | null;
};

function legsFor(a: Pick<FinAction, "kind" | "amount" | "fromAccountId" | "toAccountId">) {
  return legEffects({ ...a, id: "", label: "", status: "planned", legs: [] } as FinAction).map((l) => ({ side: l.side, accountId: l.accountId }));
}

export function addAction(checkinId: string, input: ActionInput, actor: string, correlationId: string) {
  const c = getCheckinRow(checkinId);
  assertDraft(c);
  if (input.kind === "adjustment" && !input.note?.trim()) throw new HttpError(400, "note_required", "Say what an adjustment corrects.");
  const id = newId("fat");
  db().transaction((tx) => {
    const position = Number(
      tx
        .select({ n: sql<number>`coalesce(max(${schema.finActions.position}), -1)` })
        .from(schema.finActions)
        .where(eq(schema.finActions.checkinId, checkinId))
        .get()?.n ?? -1,
    );
    tx.insert(schema.finActions)
      .values({
        id,
        checkinId,
        kind: input.kind,
        label: input.label.trim(),
        amount: input.amount,
        fromAccountId: input.fromAccountId ?? null,
        toAccountId: input.toAccountId ?? null,
        date: input.date ?? null,
        fundId: input.fundId ?? null,
        fundDecision: Boolean(input.fundDecision),
        flowId: input.flowId ?? null,
        cardBasis: input.cardBasis ?? null,
        planEventId: input.planEventId ?? null,
        note: input.note ?? null,
        position: position + 1,
        createdBy: actor,
      })
      .run();
    for (const l of legsFor(input)) tx.insert(schema.finActionLegs).values({ actionId: id, side: l.side, accountId: l.accountId, inclusion: "excluded" }).run();
  });
  auditFinance(actor, "finance.action.create", id, null, input, correlationId);
  return id;
}

function getActionRow(id: string) {
  return db().select().from(schema.finActions).where(eq(schema.finActions.id, id)).get() ?? notFound("Action");
}

/** Record (or remove) the long-term plan actual a done action stands for. */
function syncPlanActual(tx: DB, a: ActionRow, actor: string) {
  const existing = tx.select().from(schema.finActuals).where(eq(schema.finActuals.actionId, a.id)).get();
  const done = a.status === "settled" && a.planEventId;
  if (!done) {
    if (existing) tx.delete(schema.finActuals).where(eq(schema.finActuals.id, existing.id)).run();
    return;
  }
  if (existing) return;
  const ev = tx.select().from(schema.finEvents).where(eq(schema.finEvents.id, a.planEventId!)).get();
  if (!ev) return;
  const signed = ev.kind === "income" ? Math.abs(a.amount) : -Math.abs(a.amount);
  const actualId = newId("fav");
  tx.insert(schema.finActuals)
    .values({
      id: actualId,
      eventId: ev.id,
      date: a.doneAt?.slice(0, 10) ?? a.date ?? today(),
      amount: signed,
      actionId: a.id,
      note: `From check-in action “${a.label}”`,
      createdBy: actor,
    })
    .run();
  tx.insert(schema.finActualAllocations)
    .values({ id: newId("faa"), actualId, fundId: a.fundId ?? null, amount: signed, createdBy: actor })
    .run();
  if (ev.status === "open") tx.update(schema.finEvents).set({ status: "partial" }).where(eq(schema.finEvents.id, ev.id)).run();
}

export type ActionPatch = Partial<ActionInput> & { status?: ActionStatus; version: number };

export function updateAction(id: string, patch: ActionPatch, actor: string, correlationId: string) {
  const before = getActionRow(id);
  assertDraft(getCheckinRow(before.checkinId));
  const { version, ...rest } = patch;
  const set: Partial<ActionRow> = { ...rest, updatedAt: new Date().toISOString() } as Partial<ActionRow>;
  if (patch.label !== undefined) set.label = patch.label.trim();
  const wasDone = before.status === "settled";
  const nowDone = (patch.status ?? before.status) === "settled";
  if (nowDone && !wasDone) {
    set.doneAt = new Date().toISOString();
    set.doneBy = actor;
  }
  if (!nowDone && wasDone) {
    set.doneAt = null;
    set.doneBy = null;
  }
  const reshaped = ["kind", "amount", "fromAccountId", "toAccountId"].some((k) => k in rest);
  db().transaction((tx) => {
    updateVersioned(schema.finActions, eq(schema.finActions.id, id), version, set, tx as unknown as DB);
    const after = tx.select().from(schema.finActions).where(eq(schema.finActions.id, id)).get()!;
    if (reshaped) {
      tx.delete(schema.finActionLegs).where(eq(schema.finActionLegs.actionId, id)).run();
      for (const l of legsFor({ ...after, kind: after.kind as ActionKind })) {
        tx.insert(schema.finActionLegs).values({ actionId: id, side: l.side, accountId: l.accountId, inclusion: "excluded" }).run();
      }
    }
    const fundChanged = before.fundId !== after.fundId || before.amount !== after.amount;
    if ((wasDone && !nowDone) || (nowDone && fundChanged)) releaseForAction(tx as unknown as DB, id, actor);
    if (nowDone) consumeForAction(tx as unknown as DB, after, actor);
    syncPlanActual(tx as unknown as DB, after, actor);
  });
  auditFinance(actor, nowDone && !wasDone ? "finance.action.done" : "finance.action.update", id, before, set, correlationId);
}

export function deleteAction(id: string, actor: string, correlationId: string) {
  const before = getActionRow(id);
  assertDraft(getCheckinRow(before.checkinId));
  db().transaction((tx) => {
    releaseForAction(tx as unknown as DB, id, actor);
    tx.delete(schema.finActuals).where(eq(schema.finActuals.actionId, id)).run();
    tx.delete(schema.finActions).where(eq(schema.finActions.id, id)).run();
  });
  auditFinance(actor, "finance.action.delete", id, before, null, correlationId);
}

/** Record whether a leg is already in the snapshot, with the evidence. */
export function setLeg(actionId: string, side: LegSide, inclusion: Inclusion, evidence: string, actor: string, correlationId: string) {
  const a = getActionRow(actionId);
  assertDraft(getCheckinRow(a.checkinId));
  const before = db()
    .select()
    .from(schema.finActionLegs)
    .where(and(eq(schema.finActionLegs.actionId, actionId), eq(schema.finActionLegs.side, side)))
    .get();
  if (!before) notFound("Leg");
  if (inclusion !== "unknown" && !evidence.trim()) throw new HttpError(400, "evidence_required", "Say how you know (e.g. “card shows the payment on 10/02”).");
  db()
    .update(schema.finActionLegs)
    .set({ inclusion, evidence: evidence.trim() || null, confirmedBy: actor, confirmedAt: new Date().toISOString() })
    .where(and(eq(schema.finActionLegs.actionId, actionId), eq(schema.finActionLegs.side, side)))
    .run();
  auditFinance(actor, "finance.leg", `${actionId}:${side}`, before, { inclusion, evidence }, correlationId);
}

export function acknowledge(checkinId: string, key: string, note: string | undefined, actor: string, correlationId: string) {
  const c = getCheckinRow(checkinId);
  assertDraft(c);
  const result = computeCheckin(checkinInput(c));
  const issue = result.issues.find((i) => issueKey(i) === key);
  if (!issue) throw new HttpError(404, "not_found", "That issue isn't there any more.");
  if (issue.blocking) throw new HttpError(409, "blocking", "This can't be acknowledged: it has to be fixed before closing.");
  const list = acknowledgements(c).filter((a) => a.key !== key);
  list.push({ key, by: actor, at: new Date().toISOString(), note });
  db()
    .update(schema.finCheckins)
    .set({ acknowledged: JSON.stringify(list) })
    .where(eq(schema.finCheckins.id, checkinId))
    .run();
  auditFinance(actor, "finance.checkin.acknowledge", checkinId, null, { key, note }, correlationId);
}

/**
 * Close: zero blocking issues, every warning acknowledged, no refresh running,
 * and nothing changed since the caller looked (version). Freezes the result.
 */
export function closeCheckin(id: string, version: number, note: string | undefined, actor: string, correlationId: string) {
  return db().transaction((tx) => {
    const c = tx.select().from(schema.finCheckins).where(eq(schema.finCheckins.id, id)).get() ?? notFound("Check-in");
    assertDraft(c);
    if (c.version !== version) throw new HttpError(409, "version_conflict", "Something changed since you looked. Review it again before closing.");
    if (runningRun()) throw new HttpError(409, "refresh_running", "A balance refresh is running. Close after it finishes and you've reviewed the result.");
    const result = computeCheckin(checkinInput(c));
    if (result.blocking)
      throw new HttpError(409, "blocking_issues", `${result.blocking} issue${result.blocking === 1 ? "" : "s"} must be fixed before closing.`);
    if (result.unacknowledged) throw new HttpError(409, "unacknowledged", "Acknowledge the remaining warnings before closing.");
    const now = new Date().toISOString();
    updateVersioned(
      schema.finCheckins,
      eq(schema.finCheckins.id, id),
      version,
      { status: "closed", closedAt: now, closedBy: actor, closeNote: note ?? null, summary: JSON.stringify(result) },
      tx as unknown as DB,
    );
    auditFinance(actor, "finance.checkin.close", id, null, { month: c.month, net: result.ending.net, liquid: result.ending.liquid, note }, correlationId);
    return result;
  });
}

/** The check-in that matters now: this month's draft, else the latest one. */
export function currentCheckin(now = new Date()) {
  const month = thisMonth(now);
  return (
    db().select().from(schema.finCheckins).where(eq(schema.finCheckins.month, month)).get() ??
    db().select().from(schema.finCheckins).where(eq(schema.finCheckins.status, "draft")).orderBy(desc(schema.finCheckins.month)).limit(1).get() ??
    undefined
  );
}

export function currentResult(now = new Date()) {
  const c = currentCheckin(now);
  if (!c) return undefined;
  return { checkin: c, result: c.status === "closed" && c.summary ? (JSON.parse(c.summary) as CheckinResult) : computeCheckin(checkinInput(c, now)) };
}
