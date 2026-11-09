import "server-only";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { currentVia } from "./actor";
import { event, recordOp, type OpOut } from "./store";
import { appendDecisionToSummary, decisionLogText, parseDecision, serialiseDecision, type DecisionAction } from "@/lib/decisions";
import {
  PENDING_STATES,
  decisionRef,
  dedupe,
  nextState,
  parseChoices,
  parseDecisionRef,
  parsePack,
  parseRisk,
  shouldDefault,
  validateRaise,
  type AnswerVia,
  type Decision,
  type DecisionState,
  type RaiseInput,
  type RiskFlag,
} from "@/lib/cw-decisions";

/**
 * CW-2 decisions (D-n) persistence. The `decisions` table is the source of truth;
 * `work_items.decision` is the back-compat projection of the item's HEAD decision (the
 * oldest open one, JSON with "ref": "D-n"), so every older reader keeps working.
 *
 * Safety rules enforced here (not only in the callers):
 * - answer / defer / dismiss are owner-session only: refused inside an agent call (withVia "agent:*");
 * - supersede / withdraw by an agent only on decisions that agent raised;
 * - defaults apply only to open decisions with NO risk flag (re-checked at apply time).
 */

const D = schema.decisions;
const T = schema.workItems;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Db = ReturnType<typeof getDb> | Tx;
type Row = typeof D.$inferSelect;

/** Undo marker stored on the work_op: which decision row the op raised and/or closed. */
export type DecisionOp = { raised?: string; closed?: string; deferred?: { id: string; prevUntil: string | null; prevState: "open" | "deferred" } };

const nowIso = () => new Date().toISOString();

/** Next D-n: above both the highest row and a durable high-water mark, so a deleted item's D-n is never reused. */
export function nextDecisionSeq(db: Db, userId: string): number {
  const max = db
    .select({ seq: sql<number>`coalesce(max(${D.seq}), 0)` })
    .from(D)
    .where(eq(D.userId, userId))
    .get()!.seq;
  const key = `cw:decision-seq:${userId}`;
  const prior = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  const seq = Math.max(max, Number(prior?.value) || 0) + 1;
  db.insert(schema.settings)
    .values({ key, value: String(seq) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: String(seq), updatedAt: new Date().toISOString() } })
    .run();
  return seq;
}

function parseAction(raw: string | null): DecisionAction | undefined {
  if (!raw) return undefined;
  try {
    const a = JSON.parse(raw) as DecisionAction;
    return a && typeof a.label === "string" && typeof a.href === "string" ? a : undefined;
  } catch {
    return undefined;
  }
}

export function toDecision(r: Row): Decision {
  const action = parseAction(r.actionJson);
  return {
    id: r.id,
    ref: decisionRef(r.seq),
    seq: r.seq,
    itemId: r.itemId,
    runId: r.runId,
    question: r.question,
    choices: parseChoices(r.choicesJson),
    recommended: r.recommended,
    risk: parseRisk(r.riskJson),
    pack: parsePack(r.packJson),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(action ? { action } : {}),
    defaultChoice: r.defaultChoice,
    expiresAt: r.expiresAt,
    state: r.state as DecisionState,
    answeredChoice: r.answeredChoice,
    answeredAt: r.answeredAt,
    answeredVia: (r.answeredVia as AnswerVia | null) ?? null,
    deferredUntil: r.deferredUntil,
    supersededBy: r.supersededBy,
    raisedBy: r.raisedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The work_items.decision JSON for a head row. */
export function headJson(r: Row): string {
  return serialiseDecision(
    { question: r.question, choices: parseChoices(r.choicesJson), detail: r.detail ?? undefined, action: parseAction(r.actionJson), ref: decisionRef(r.seq) },
    r.askedAt,
  );
}

function openRows(db: Db, userId: string, itemId: string, except?: string): Row[] {
  return db
    .select()
    .from(D)
    .where(and(eq(D.userId, userId), eq(D.itemId, itemId), eq(D.state, "open")))
    .orderBy(asc(D.seq))
    .all()
    .filter((r) => r.id !== except);
}

export function rowByRef(db: Db, userId: string, ref: string): Row | undefined {
  const seq = parseDecisionRef(ref);
  if (seq === null) return undefined;
  return db
    .select()
    .from(D)
    .where(and(eq(D.userId, userId), eq(D.seq, seq)))
    .get();
}

/** Row by "D-n" or by row id. */
export function findDecision(db: Db, userId: string, refOrId: string): Row | undefined {
  return (
    rowByRef(db, userId, refOrId) ??
    db
      .select()
      .from(D)
      .where(and(eq(D.userId, userId), eq(D.id, refOrId)))
      .get()
  );
}

/**
 * Keep work_items.decision = the item's head decision. Leaves it alone while it already
 * points at an open row (so an undo snapshot stays valid); else the oldest open row, else null.
 */
export function syncHead(db: Db, userId: string, itemId: string): void {
  const item = db
    .select({ decision: T.decision })
    .from(T)
    .where(and(eq(T.id, itemId), eq(T.userId, userId)))
    .get();
  if (!item) return;
  const open = openRows(db, userId, itemId);
  const cur = parseDecision(item.decision);
  if (cur?.ref && open.some((r) => decisionRef(r.seq) === cur.ref)) return;
  const next = open[0] ? headJson(open[0]) : null;
  if ((item.decision ?? null) === next) return;
  db.update(T).set({ decision: next, updatedAt: nowIso() }).where(eq(T.id, itemId)).run();
}

/**
 * A work_items.decision written by a raw insert (portfolio import, old rows) with no D-n row
 * behind it: give it one and stamp the ref into the JSON. Leaves updatedAt alone.
 */
export function adoptHeadDecision(db: Db, userId: string, itemId: string): void {
  const item = db
    .select({ decision: T.decision, updatedAt: T.updatedAt })
    .from(T)
    .where(and(eq(T.id, itemId), eq(T.userId, userId)))
    .get();
  const d = parseDecision(item?.decision);
  if (!item || !d) return;
  const known = d.ref ? rowByRef(db, userId, d.ref) : undefined;
  if (known && known.itemId === itemId) return;
  const row = insertDecision(
    db,
    userId,
    itemId,
    { question: d.question, choices: d.choices, detail: d.detail },
    { raisedBy: currentVia() ?? `person:${userId}`, action: d.action, askedAt: d.askedAt || item.updatedAt },
  );
  db.update(T)
    .set({ decision: headJson(row) })
    .where(eq(T.id, itemId))
    .run();
}

/** Refuse owner-only actions inside an agent (MCP) call. */
export function assertOwnerSession(what = "answer decisions") {
  if (currentVia()?.startsWith("agent:")) throw new HttpError(403, "owner_only", `Only the owner can ${what}`);
}

type RaiseOpts = { raisedBy: string; action?: DecisionAction; askedAt?: string; now?: Date };

/** Insert one decision row (validated). Caller syncs the head. */
export function insertDecision(db: Db, userId: string, itemId: string, input: RaiseInput, opts: RaiseOpts): Row {
  const now = opts.now ?? new Date();
  const check = validateRaise(input, now);
  if (!check.ok) throw new HttpError(400, check.code, check.message);
  const id = newId("dec");
  const at = now.toISOString();
  const choices = dedupe(input.choices ?? []);
  const risk = [...new Set(input.risk ?? [])];
  db.insert(D)
    .values({
      id,
      userId,
      seq: nextDecisionSeq(db, userId),
      itemId,
      runId: input.runId ?? null,
      question: input.question.trim(),
      choicesJson: JSON.stringify(choices),
      recommended: input.recommended?.trim() ?? null,
      riskJson: JSON.stringify(risk),
      packJson: JSON.stringify(input.pack ?? {}),
      detail: input.detail?.trim() || null,
      actionJson: opts.action ? JSON.stringify(opts.action) : null,
      defaultChoice: risk.length ? null : (input.defaultChoice?.trim() ?? null),
      expiresAt: risk.length ? null : input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      state: "open",
      raisedBy: opts.raisedBy,
      askedAt: opts.askedAt ?? at,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return db.select().from(D).where(eq(D.id, id)).get()!;
}

function itemRow(db: Db, userId: string, itemId: string) {
  const r = db
    .select()
    .from(T)
    .where(and(eq(T.id, itemId), eq(T.userId, userId)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "Work item not found");
  return r;
}

/**
 * Raise a decision on an item (agents via MCP, server code). Several may be open per item.
 * `supersedes` (D-n) closes an older one the SAME raiser opened, linking it to the new one.
 */
export function raiseDecision(
  userId: string,
  itemId: string,
  input: RaiseInput & { supersedes?: string },
  opts: RaiseOpts & { correlationId: string },
): Decision {
  const db = getDb();
  const out = db.transaction((tx) => {
    const item = itemRow(tx, userId, itemId);
    if (item.kind === "conversation") throw new HttpError(400, "decision_kind", "Ask on the work item, not the conversation");
    let old: Row | undefined;
    if (input.supersedes) {
      old = findDecision(tx, userId, input.supersedes);
      if (!old) throw new HttpError(404, "not_found", "No decision with that id");
      if (old.raisedBy !== opts.raisedBy) throw new HttpError(403, "not_yours", "Only the raiser can supersede a decision");
      if (!nextState(old.state as DecisionState, "supersede")) throw new HttpError(409, "decision_closed", `${decisionRef(old.seq)} is already ${old.state}`);
    }
    const { supersedes: _s, ...raise } = input;
    void _s;
    const row = insertDecision(tx, userId, itemId, raise, opts);
    event(tx, itemId, userId, { kind: "edit", reason: `Needs your decision: ${row.question}` });
    if (old) {
      tx.update(D).set({ state: "superseded", supersededBy: row.id, updatedAt: nowIso() }).where(eq(D.id, old.id)).run();
      event(tx, old.itemId, userId, { kind: "edit", reason: `${decisionRef(old.seq)} superseded by ${decisionRef(row.seq)}` });
      if (old.itemId !== itemId) syncHead(tx, userId, old.itemId);
    }
    syncHead(tx, userId, itemId);
    // Undoable from Activity like any agent write (7-day window for agent ops): Undo withdraws the new
    // row and reopens a superseded one (undoDecisionOp), then re-projects the head.
    recordOp(tx, userId, itemId, "edit", { prev: {}, next: {}, decisionOp: { raised: row.id, ...(old ? { closed: old.id } : {}) } satisfies DecisionOp });
    return row;
  });
  audit({
    actor: opts.raisedBy,
    action: "decision.raise",
    source: "work",
    sourceRecord: out.id,
    result: "ok",
    correlationId: opts.correlationId,
    detail: { ref: decisionRef(out.seq), itemId, risk: parseRisk(out.riskJson), hasDefault: !!out.defaultChoice },
  });
  return toDecision(out);
}

/** An agent closes a decision it raised (no replacement): withdrawn. */
export function withdrawDecision(userId: string, refOrId: string, raisedBy: string, reason: string, correlationId: string): Decision {
  const db = getDb();
  const row = db.transaction((tx) => {
    const r = findDecision(tx, userId, refOrId);
    if (!r) throw new HttpError(404, "not_found", "No decision with that id");
    if (r.raisedBy !== raisedBy) throw new HttpError(403, "not_yours", "Only the raiser can withdraw a decision");
    if (!nextState(r.state as DecisionState, "withdraw")) throw new HttpError(409, "decision_closed", `${decisionRef(r.seq)} is already ${r.state}`);
    tx.update(D).set({ state: "withdrawn", updatedAt: nowIso() }).where(eq(D.id, r.id)).run();
    event(tx, r.itemId, userId, { kind: "edit", reason: `${decisionRef(r.seq)} withdrawn: ${reason}`.slice(0, 500) });
    syncHead(tx, userId, r.itemId);
    recordOp(tx, userId, r.itemId, "edit", { prev: {}, next: {}, decisionOp: { closed: r.id } satisfies DecisionOp });
    return tx.select().from(D).where(eq(D.id, r.id)).get()!;
  });
  audit({ actor: raisedBy, action: "decision.withdraw", source: "work", sourceRecord: row.id, result: "ok", correlationId });
  return toDecision(row);
}

/**
 * Close one decision with an answer (owner) or its default (job): appends "Decision: Q → A"
 * to the item summary, logs a `decision` event, promotes the next head, and records ONE
 * undoable edit op (undo restores the summary + head and reopens the row).
 */
function closeWithAnswer(tx: Tx, userId: string, r: Row, answer: string, state: "answered" | "defaulted", via: AnswerVia, out?: OpOut) {
  const item = itemRow(tx, userId, r.itemId);
  const at = nowIso();
  const summary = appendDecisionToSummary(item.summary, r.question, state === "defaulted" ? `${answer} (default)` : answer, at);
  tx.update(D).set({ state, answeredChoice: answer, answeredAt: at, answeredVia: via, deferredUntil: null, updatedAt: at }).where(eq(D.id, r.id)).run();
  const cur = parseDecision(item.decision);
  const isHead = cur?.ref === decisionRef(r.seq);
  const promoted = isHead ? (openRows(tx, userId, r.itemId, r.id)[0] ?? null) : null;
  const nextDecision = isHead ? (promoted ? headJson(promoted) : null) : undefined;
  event(tx, r.itemId, userId, {
    kind: "decision",
    // Same activity text as before D-n rows ("Decision: <q> → <a>"); the ref lives on the decision row.
    reason: `${decisionLogText(r.question, answer)}${state === "defaulted" ? " (default applied)" : ""}`.slice(0, 1000),
  });
  const prev: Record<string, unknown> = { summary: item.summary };
  const next: Record<string, unknown> = { summary };
  if (nextDecision !== undefined) {
    prev.decision = item.decision;
    next.decision = nextDecision;
  }
  recordOp(tx, userId, r.itemId, "edit", { prev, next, decisionOp: { closed: r.id } satisfies DecisionOp }, out);
  tx.update(T)
    .set({ summary, ...(nextDecision !== undefined ? { decision: nextDecision } : {}), updatedAt: at })
    .where(eq(T.id, r.itemId))
    .run();
}

/** Owner answers a decision by D-n / id. Idempotent for a repeat of the same answer (push replays). */
export function answerDecisionRef(
  userId: string,
  refOrId: string,
  answer: string,
  via: AnswerVia,
  correlationId: string,
  out?: OpOut,
): { decision: Decision; repeated?: boolean } {
  assertOwnerSession();
  const text = answer.trim();
  if (!text) throw new HttpError(400, "answer", "Answer is empty");
  const db = getDb();
  let repeated = false;
  const row = db.transaction((tx) => {
    const r = findDecision(tx, userId, refOrId);
    if (!r) throw new HttpError(404, "not_found", "No decision with that id");
    if (r.state === "answered" && r.answeredChoice === text) {
      repeated = true;
      return r;
    }
    if (!nextState(r.state as DecisionState, "answer"))
      throw new HttpError(409, "decision_closed", `${decisionRef(r.seq)} is already ${r.state}${r.answeredChoice ? ` (${r.answeredChoice})` : ""}`);
    const wasDeferred = r.state === "deferred";
    closeWithAnswer(tx, userId, r, text, "answered", via, out);
    if (wasDeferred) syncHead(tx, userId, r.itemId);
    return tx.select().from(D).where(eq(D.id, r.id)).get()!;
  });
  if (!repeated)
    audit({
      actor: userId,
      action: "work.decision",
      source: "work",
      sourceRecord: row.itemId,
      result: "ok",
      correlationId,
      detail: { ref: decisionRef(row.seq), via },
    });
  return { decision: toDecision(row), ...(repeated ? { repeated } : {}) };
}

/**
 * Legacy single-decision answer (POST /api/work/items/<id>/decision): answers the item's head.
 * A head JSON without a ref (written before 0043 or by a path that bypassed the store) gets a row first.
 */
export function answerItemHead(userId: string, itemId: string, answer: string, correlationId: string, out?: OpOut, expectedRef?: string) {
  assertOwnerSession();
  const db = getDb();
  const ref = db.transaction((tx) => {
    const item = itemRow(tx, userId, itemId);
    const d = parseDecision(item.decision);
    if (!d) throw new HttpError(409, "no_decision", "This item isn't waiting on a decision any more");
    // The owner confirmed one question: never let it land on a newer head (D-1 answered elsewhere → D-2).
    if (expectedRef && d.ref !== expectedRef) throw new HttpError(409, "decision_changed", `${expectedRef} was already answered or replaced`);
    let r = d.ref ? rowByRef(tx, userId, d.ref) : undefined;
    if (!r || r.itemId !== itemId) {
      r = insertDecision(
        tx,
        userId,
        itemId,
        { question: d.question, choices: d.choices, detail: d.detail },
        { raisedBy: `person:${userId}`, action: d.action, askedAt: d.askedAt || item.updatedAt },
      );
      tx.update(T)
        .set({ decision: headJson(r) })
        .where(eq(T.id, itemId))
        .run();
    }
    if (r.state !== "open" && r.state !== "deferred") throw new HttpError(409, "no_decision", "This item isn't waiting on a decision any more");
    return decisionRef(r.seq);
  });
  return answerDecisionRef(userId, ref, answer, "item", correlationId, out);
}

/** Owner defers a decision until a time (≤ 30 days). It leaves the queue and comes back on its own. */
export function deferDecision(userId: string, refOrId: string, until: string, correlationId: string, now = new Date(), out?: OpOut): Decision {
  assertOwnerSession("defer decisions");
  const t = Date.parse(until);
  if (!(t > now.getTime() && t - now.getTime() <= 30 * 86_400_000)) throw new HttpError(400, "until", "Defer to a time within the next 30 days");
  const db = getDb();
  const row = db.transaction((tx) => {
    const r = findDecision(tx, userId, refOrId);
    if (!r) throw new HttpError(404, "not_found", "No decision with that id");
    if (!nextState(r.state as DecisionState, "defer")) throw new HttpError(409, "decision_closed", `${decisionRef(r.seq)} is already ${r.state}`);
    tx.update(D)
      .set({ state: "deferred", deferredUntil: new Date(t).toISOString(), updatedAt: nowIso() })
      .where(eq(D.id, r.id))
      .run();
    event(tx, r.itemId, userId, { kind: "edit", reason: `${decisionRef(r.seq)} deferred until ${new Date(t).toISOString()}` });
    syncHead(tx, userId, r.itemId);
    // Undoable: an accidental 30-day defer comes straight back.
    const deferred = { id: r.id, prevUntil: r.deferredUntil, prevState: r.state === "deferred" ? "deferred" : "open" } as const;
    recordOp(tx, userId, r.itemId, "edit", { prev: {}, next: {}, decisionOp: { deferred } satisfies DecisionOp }, out);
    return tx.select().from(D).where(eq(D.id, r.id)).get()!;
  });
  audit({ actor: userId, action: "decision.defer", source: "work", sourceRecord: row.id, result: "ok", correlationId });
  return toDecision(row);
}

/**
 * updateItem's `decision` field (owner edit, request_change, device and scheduled-job
 * proposals): mirror it into the table. Returns the JSON to store (with "ref") and the undo marker.
 */
export function legacyDecisionWrite(
  tx: Tx,
  userId: string,
  item: { id: string; decision: string | null },
  nextJson: string | null,
  risk: RiskFlag[] = [],
): { json: string | null; decisionOp: DecisionOp } {
  const cur = parseDecision(item.decision);
  const curRow = cur?.ref ? rowByRef(tx, userId, cur.ref) : undefined;
  const live = curRow && curRow.itemId === item.id && (PENDING_STATES as string[]).includes(curRow.state) ? curRow : undefined;
  const d = parseDecision(nextJson);
  if (!d) {
    if (live) tx.update(D).set({ state: "withdrawn", updatedAt: nowIso() }).where(eq(D.id, live.id)).run();
    const promoted = openRows(tx, userId, item.id, live?.id)[0];
    return { json: promoted ? headJson(promoted) : null, decisionOp: live ? { closed: live.id } : {} };
  }
  const row = insertDecision(
    tx,
    userId,
    item.id,
    { question: d.question, choices: d.choices, detail: d.detail, risk },
    { raisedBy: currentVia() ?? `person:${userId}`, action: d.action, askedAt: d.askedAt || nowIso() },
  );
  if (live) tx.update(D).set({ state: "superseded", supersededBy: row.id, updatedAt: nowIso() }).where(eq(D.id, live.id)).run();
  return { json: headJson(row), decisionOp: { raised: row.id, ...(live ? { closed: live.id } : {}) } };
}

/** Undo of an edit op that raised and/or closed decision rows (called inside undoOp's transaction). */
export function undoDecisionOp(tx: Tx, userId: string, op: DecisionOp) {
  const at = nowIso();
  if (op.raised)
    tx.update(D)
      .set({ state: "withdrawn", updatedAt: at })
      .where(and(eq(D.id, op.raised), eq(D.userId, userId), inArray(D.state, ["open", "deferred"])))
      .run();
  if (op.closed) {
    // Undo is the owner's reversal: the default is dropped so the next tick can't re-apply it.
    tx.update(D)
      .set({
        state: "open",
        answeredChoice: null,
        answeredAt: null,
        answeredVia: null,
        supersededBy: null,
        deferredUntil: null,
        defaultChoice: null,
        expiresAt: null,
        updatedAt: at,
      })
      .where(and(eq(D.id, op.closed), eq(D.userId, userId)))
      .run();
  }
  if (op.deferred)
    tx.update(D)
      .set({ state: op.deferred.prevState, deferredUntil: op.deferred.prevUntil, updatedAt: at })
      .where(and(eq(D.id, op.deferred.id), eq(D.userId, userId), eq(D.state, "deferred")))
      .run();
  // Re-project each touched item's head (raise/withdraw/defer ops carry no `prev.decision` to restore).
  const ids = [op.raised, op.closed, op.deferred?.id].filter((x): x is string => !!x);
  const items = ids.length
    ? tx
        .select({ itemId: D.itemId })
        .from(D)
        .where(and(eq(D.userId, userId), inArray(D.id, ids)))
        .all()
    : [];
  for (const itemId of new Set(items.map((i) => i.itemId))) syncHead(tx, userId, itemId);
}

/**
 * Dispatcher tick: bring deferred decisions back when due, and apply the default of each
 * open, LOW-RISK decision whose expiry passed (audited, undoable from Activity / the row).
 */
export function applyDueDecisions(now = new Date()): { defaulted: string[]; undeferred: string[] } {
  const db = getDb();
  const iso = now.toISOString();
  const undeferred: string[] = [];
  const defaulted: string[] = [];
  const due = db
    .select()
    .from(D)
    .where(and(eq(D.state, "deferred"), isNotNull(D.deferredUntil), lte(D.deferredUntil, iso)))
    .all();
  for (const r of due) {
    db.transaction((tx) => {
      tx.update(D).set({ state: "open", deferredUntil: null, updatedAt: iso }).where(eq(D.id, r.id)).run();
      syncHead(tx, r.userId, r.itemId);
    });
    undeferred.push(decisionRef(r.seq));
  }
  const expiring = db
    .select()
    .from(D)
    .where(and(eq(D.state, "open"), isNotNull(D.defaultChoice), isNotNull(D.expiresAt), lte(D.expiresAt, iso)))
    .all();
  for (const r of expiring) {
    const risk = parseRisk(r.riskJson);
    if (!shouldDefault({ state: r.state as DecisionState, risk, defaultChoice: r.defaultChoice, expiresAt: r.expiresAt }, now)) {
      if (risk.length) {
        // A risk-flagged row must never carry a default (validateRaise refuses it); strip it once, audited.
        db.update(D).set({ defaultChoice: null, expiresAt: null, updatedAt: iso }).where(eq(D.id, r.id)).run();
        audit({
          actor: "system:decision-default",
          action: "decision.default",
          source: "work",
          sourceRecord: r.id,
          result: "rejected",
          correlationId: `default:${r.id}`,
          detail: { reason: "risk", risk },
        });
      }
      continue;
    }
    try {
      db.transaction((tx) => closeWithAnswer(tx, r.userId, r, r.defaultChoice!, "defaulted", "default"));
      defaulted.push(decisionRef(r.seq));
      audit({
        actor: "system:decision-default",
        action: "decision.default",
        source: "work",
        sourceRecord: r.id,
        result: "ok",
        correlationId: `default:${r.id}`,
        detail: { ref: decisionRef(r.seq), choice: r.defaultChoice },
      });
    } catch (e) {
      audit({
        actor: "system:decision-default",
        action: "decision.default",
        source: "work",
        sourceRecord: r.id,
        result: "error",
        correlationId: `default:${r.id}`,
        detail: { message: String((e as Error).message).slice(0, 200) },
      });
    }
  }
  return { defaulted, undeferred };
}

/** The owner's decisions (newest first), optionally filtered. Visibility filtering is the caller's. */
export function listDecisionRows(userId: string, opts: { states?: DecisionState[]; itemIds?: string[]; since?: string; limit?: number } = {}): Decision[] {
  const db = getDb();
  const rows = db
    .select()
    .from(D)
    .where(and(eq(D.userId, userId), ...(opts.states?.length ? [inArray(D.state, opts.states)] : [])))
    .all()
    .filter((r) => (!opts.itemIds || opts.itemIds.includes(r.itemId)) && (!opts.since || r.updatedAt >= opts.since))
    .sort((a, b) => b.seq - a.seq);
  return rows.slice(0, opts.limit ?? 500).map(toDecision);
}
