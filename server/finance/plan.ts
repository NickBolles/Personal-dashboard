import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema, type DB } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import {
  computePlan,
  type ActualInstallment,
  type EventEstimate,
  type PlanEvent,
  type PlanEventKind,
  type PlanMode,
  type PlanResult,
} from "@/lib/finance/plan";
import { csvObjects, parseDate, parseMoney } from "@/lib/finance/csv";
import type { Cents } from "@/lib/finance/types";
import { auditFinance, notFound, updateVersioned } from "./common";
import { createFund, listFunds } from "./funds";

type RevisionRow = typeof schema.finRevisions.$inferSelect;
const db = () => getDb();

export type RevisionView = Pick<
  RevisionRow,
  "id" | "year" | "name" | "kind" | "changeNote" | "createdBy" | "createdAt" | "promotedAt" | "version" | "basedOnId"
> & {
  provenance: Record<string, string> | null;
  editable: boolean;
};

const toRevision = (r: RevisionRow): RevisionView => ({
  id: r.id,
  year: r.year,
  name: r.name,
  kind: r.kind,
  changeNote: r.changeNote,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  promotedAt: r.promotedAt,
  version: r.version,
  basedOnId: r.basedOnId,
  provenance: r.provenance ? (JSON.parse(r.provenance) as Record<string, string>) : null,
  editable: r.kind !== "archived",
});

function revisionRow(id: string) {
  return db().select().from(schema.finRevisions).where(eq(schema.finRevisions.id, id)).get() ?? notFound("Revision");
}

function assertEditable(r: RevisionRow) {
  if (r.kind === "archived") throw new HttpError(409, "read_only", "Old revisions are read-only. Create a new revision to change the plan.");
}

export function listYears() {
  return db().select().from(schema.finPlanYears).orderBy(desc(schema.finPlanYears.year)).all();
}

export function revisionsFor(year: number) {
  return db().select().from(schema.finRevisions).where(eq(schema.finRevisions.year, year)).orderBy(asc(schema.finRevisions.createdAt)).all().map(toRevision);
}

export function activeRevisionId(year: number) {
  return db().select().from(schema.finPlanYears).where(eq(schema.finPlanYears.year, year)).get()?.activeRevisionId ?? null;
}

/** Create a plan year with its first (active) revision, rolling fund endings over from the previous year when it exists. */
export function ensureYear(year: number, actor: string, correlationId: string) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, "bad_year", "Pick a year between 2000 and 2100.");
  const existing = db().select().from(schema.finPlanYears).where(eq(schema.finPlanYears.year, year)).get();
  if (existing?.activeRevisionId) return existing.activeRevisionId;
  const prevActive = activeRevisionId(year - 1);
  const rollover = prevActive ? getPlan(year - 1, prevActive, "forecast").result.endings : {};
  const id = newId("frv");
  db().transaction((tx) => {
    tx.insert(schema.finRevisions).values({ id, year, name: "Version 1", kind: "active", changeNote: "Plan started", createdBy: actor }).run();
    for (const f of listFunds()) {
      tx.insert(schema.finRevisionFunds)
        .values({ revisionId: id, fundId: f.id, opening: rollover[f.id] ?? 0, rolloverNote: prevActive ? `Forecast ending of ${year - 1}` : null })
        .run();
    }
    tx.insert(schema.finPlanYears)
      .values({ year, activeRevisionId: id })
      .onConflictDoUpdate({ target: schema.finPlanYears.year, set: { activeRevisionId: id } })
      .run();
  });
  auditFinance(actor, "finance.plan.year", String(year), null, { revision: id, rolledOver: Boolean(prevActive) }, correlationId);
  return id;
}

/**
 * A new revision copies another one (the active one by default). It starts
 * hypothetical: it never affects check-ins or the active forecast until
 * promoted. A change note is required.
 */
export function createRevision(
  year: number,
  input: { name: string; changeNote: string; basedOnId?: string; provenance?: Record<string, string> },
  actor: string,
  correlationId: string,
) {
  if (!input.changeNote.trim()) throw new HttpError(400, "note_required", "Say why this revision exists.");
  const base = input.basedOnId ?? activeRevisionId(year);
  const id = newId("frv");
  db().transaction((tx) => {
    tx.insert(schema.finRevisions)
      .values({
        id,
        year,
        name: input.name.trim(),
        kind: "hypothetical",
        basedOnId: base,
        changeNote: input.changeNote.trim(),
        provenance: input.provenance ? JSON.stringify(input.provenance) : null,
        createdBy: actor,
      })
      .run();
    if (base) {
      for (const e of tx.select().from(schema.finEventEstimates).where(eq(schema.finEventEstimates.revisionId, base)).all()) {
        tx.insert(schema.finEventEstimates)
          .values({ ...e, revisionId: id })
          .run();
      }
      for (const f of tx.select().from(schema.finRevisionFunds).where(eq(schema.finRevisionFunds.revisionId, base)).all()) {
        tx.insert(schema.finRevisionFunds)
          .values({ ...f, revisionId: id })
          .run();
      }
    }
  });
  auditFinance(actor, "finance.plan.revision", id, null, { year, ...input, basedOnId: base }, correlationId);
  return id;
}

/** Make a revision the active one; the previous active becomes read-only. Actuals are untouched. */
export function promoteRevision(id: string, version: number, actor: string, correlationId: string) {
  const r = revisionRow(id);
  if (r.kind !== "hypothetical") throw new HttpError(409, "not_hypothetical", "Only a hypothetical revision can be promoted.");
  const prev = activeRevisionId(r.year);
  db().transaction((tx) => {
    updateVersioned(
      schema.finRevisions,
      eq(schema.finRevisions.id, id),
      version,
      { kind: "active", promotedAt: new Date().toISOString() },
      tx as unknown as DB,
    );
    if (prev && prev !== id) tx.update(schema.finRevisions).set({ kind: "archived" }).where(eq(schema.finRevisions.id, prev)).run();
    tx.update(schema.finPlanYears).set({ activeRevisionId: id }).where(eq(schema.finPlanYears.year, r.year)).run();
  });
  auditFinance(actor, "finance.plan.promote", id, { active: prev }, { active: id }, correlationId);
}

export type EstimateInput = { date: string; amount: Cents; allocations: Record<string, Cents>; removed?: boolean };

export function upsertEstimate(revisionId: string, eventId: string, input: EstimateInput, actor: string, correlationId: string) {
  const r = revisionRow(revisionId);
  assertEditable(r);
  const before = db()
    .select()
    .from(schema.finEventEstimates)
    .where(and(eq(schema.finEventEstimates.revisionId, revisionId), eq(schema.finEventEstimates.eventId, eventId)))
    .get();
  const values = {
    revisionId,
    eventId,
    date: input.date,
    amount: input.amount,
    allocations: JSON.stringify(input.allocations),
    removed: Boolean(input.removed),
  };
  db()
    .insert(schema.finEventEstimates)
    .values(values)
    .onConflictDoUpdate({ target: [schema.finEventEstimates.revisionId, schema.finEventEstimates.eventId], set: values })
    .run();
  auditFinance(actor, "finance.plan.estimate", `${revisionId}:${eventId}`, before, values, correlationId);
}

export function createEvent(
  revisionId: string,
  input: { label: string; kind: PlanEventKind } & EstimateInput,
  actor: string,
  correlationId: string,
  extra: { imported?: boolean; provenance?: Record<string, string> } = {},
) {
  const r = revisionRow(revisionId);
  assertEditable(r);
  const id = newId("fev");
  db().transaction((tx) => {
    tx.insert(schema.finEvents)
      .values({
        id,
        year: r.year,
        label: input.label.trim(),
        kind: input.kind,
        imported: Boolean(extra.imported),
        provenance: extra.provenance ? JSON.stringify(extra.provenance) : null,
      })
      .run();
    tx.insert(schema.finEventEstimates)
      .values({ revisionId, eventId: id, date: input.date, amount: input.amount, allocations: JSON.stringify(input.allocations) })
      .run();
  });
  auditFinance(actor, "finance.plan.event", id, null, input, correlationId);
  return id;
}

export function updateEvent(
  id: string,
  patch: { label?: string; status?: PlanEvent["status"]; remainingAmount?: Cents | null; reconciled?: boolean; version: number },
  actor: string,
  correlationId: string,
) {
  const before = db().select().from(schema.finEvents).where(eq(schema.finEvents.id, id)).get() ?? notFound("Event");
  const { version, reconciled, ...set } = patch;
  updateVersioned(schema.finEvents, eq(schema.finEvents.id, id), version, { ...set, ...(reconciled ? { imported: false } : {}) });
  auditFinance(actor, "finance.plan.event.update", id, before, patch, correlationId);
}

/** Record a confirmed installment with its fund effects (signed); any remainder can be explicitly unallocated. */
export function addActual(
  eventId: string,
  input: { date: string; amount: Cents; allocations: { fundId: string | null; amount: Cents }[]; note?: string; complete?: boolean },
  actor: string,
  correlationId: string,
) {
  const ev = db().select().from(schema.finEvents).where(eq(schema.finEvents.id, eventId)).get() ?? notFound("Event");
  const id = newId("fav");
  db().transaction((tx) => {
    tx.insert(schema.finActuals).values({ id, eventId, date: input.date, amount: input.amount, note: input.note, createdBy: actor }).run();
    for (const a of input.allocations.filter((x) => x.amount !== 0)) {
      tx.insert(schema.finActualAllocations)
        .values({ id: newId("faa"), actualId: id, fundId: a.fundId, amount: a.amount, createdBy: actor })
        .run();
    }
    tx.update(schema.finEvents)
      .set({ status: input.complete ? "complete" : "partial", version: ev.version + 1 })
      .where(eq(schema.finEvents.id, eventId))
      .run();
  });
  auditFinance(actor, "finance.plan.actual", id, null, { eventId, ...input }, correlationId);
  return id;
}

/** Correct an actual's fund effects: a new audited row, never an edit of history (F5). */
export function correctActual(actualId: string, input: { fundId: string | null; amount: Cents; note: string }, actor: string, correlationId: string) {
  if (!input.note.trim()) throw new HttpError(400, "note_required", "Say why this correction is needed.");
  if (!db().select().from(schema.finActuals).where(eq(schema.finActuals.id, actualId)).get()) notFound("Actual");
  const id = newId("faa");
  db()
    .insert(schema.finActualAllocations)
    .values({ id, actualId, fundId: input.fundId, amount: input.amount, correction: true, note: input.note.trim(), createdBy: actor })
    .run();
  auditFinance(actor, "finance.plan.correction", actualId, null, input, correlationId);
  return id;
}

export function setOpening(
  revisionId: string,
  fundId: string,
  input: { opening: Cents; goal?: Cents | null; rolloverNote?: string | null },
  actor: string,
  correlationId: string,
) {
  const r = revisionRow(revisionId);
  assertEditable(r);
  const before = db()
    .select()
    .from(schema.finRevisionFunds)
    .where(and(eq(schema.finRevisionFunds.revisionId, revisionId), eq(schema.finRevisionFunds.fundId, fundId)))
    .get();
  const values = { revisionId, fundId, opening: input.opening, goal: input.goal ?? null, rolloverNote: input.rolloverNote ?? before?.rolloverNote ?? null };
  db()
    .insert(schema.finRevisionFunds)
    .values(values)
    .onConflictDoUpdate({ target: [schema.finRevisionFunds.revisionId, schema.finRevisionFunds.fundId], set: values })
    .run();
  auditFinance(actor, "finance.plan.opening", `${revisionId}:${fundId}`, before, values, correlationId);
}

export type ActualView = ActualInstallment & {
  note: string | null;
  createdBy: string;
  actionId: string | null;
  allocationRows: { id: string; fundId: string | null; amount: Cents; correction: boolean; note: string | null; createdBy: string; createdAt: string }[];
};

export function actualsFor(year: number): ActualView[] {
  const events = db().select({ id: schema.finEvents.id }).from(schema.finEvents).where(eq(schema.finEvents.year, year)).all();
  if (!events.length) return [];
  const actuals = db()
    .select()
    .from(schema.finActuals)
    .where(
      inArray(
        schema.finActuals.eventId,
        events.map((e) => e.id),
      ),
    )
    .orderBy(asc(schema.finActuals.date))
    .all();
  const allocations = actuals.length
    ? db()
        .select()
        .from(schema.finActualAllocations)
        .where(
          inArray(
            schema.finActualAllocations.actualId,
            actuals.map((a) => a.id),
          ),
        )
        .orderBy(asc(schema.finActualAllocations.createdAt))
        .all()
    : [];
  return actuals.map((a) => {
    const rows = allocations.filter((x) => x.actualId === a.id);
    return {
      id: a.id,
      eventId: a.eventId,
      date: a.date,
      amount: a.amount,
      note: a.note,
      createdBy: a.createdBy,
      actionId: a.actionId,
      allocations: rows.map((x) => ({ fundId: x.fundId, amount: x.amount })),
      allocationRows: rows.map((x) => ({
        id: x.id,
        fundId: x.fundId,
        amount: x.amount,
        correction: x.correction,
        note: x.note,
        createdBy: x.createdBy,
        createdAt: x.createdAt,
      })),
    };
  });
}

export type PlanView = {
  year: number;
  years: number[];
  revisions: RevisionView[];
  revision: RevisionView;
  mode: PlanMode;
  funds: { id: string; name: string; opening: Cents; goal: Cents | null; rolloverNote: string | null }[];
  events: (PlanEvent & { version: number; provenance: Record<string, string> | null })[];
  estimates: EventEstimate[];
  actuals: ActualView[];
  result: PlanResult;
};

export function getPlan(year: number, revisionId: string | undefined, mode: PlanMode): PlanView {
  const revs = revisionsFor(year);
  const rid = revisionId ?? activeRevisionId(year) ?? revs.at(-1)?.id;
  if (!rid) notFound("Plan year");
  const revision = revs.find((r) => r.id === rid) ?? notFound("Revision");
  const openings = db().select().from(schema.finRevisionFunds).where(eq(schema.finRevisionFunds.revisionId, rid)).all();
  const funds = listFunds().map((f) => {
    const o = openings.find((x) => x.fundId === f.id);
    return { id: f.id, name: f.name, opening: o?.opening ?? 0, goal: o?.goal ?? null, rolloverNote: o?.rolloverNote ?? null };
  });
  const events = db()
    .select()
    .from(schema.finEvents)
    .where(eq(schema.finEvents.year, year))
    .all()
    .map((e) => ({
      id: e.id,
      label: e.label,
      kind: e.kind as PlanEventKind,
      status: e.status as PlanEvent["status"],
      remainingAmount: e.remainingAmount,
      imported: e.imported,
      version: e.version,
      provenance: e.provenance ? (JSON.parse(e.provenance) as Record<string, string>) : null,
    }));
  const estimates = db()
    .select()
    .from(schema.finEventEstimates)
    .where(eq(schema.finEventEstimates.revisionId, rid))
    .all()
    .map((e) => ({ eventId: e.eventId, date: e.date, amount: e.amount, allocations: JSON.parse(e.allocations) as Record<string, Cents>, removed: e.removed }));
  const actuals = actualsFor(year);
  const result = computePlan({
    funds,
    openings: Object.fromEntries(funds.map((f) => [f.id, f.opening])),
    goals: Object.fromEntries(funds.filter((f) => f.goal !== null).map((f) => [f.id, f.goal!])),
    events,
    estimates,
    actuals,
    mode,
  });
  return { year, years: listYears().map((y) => y.year), revisions: revs, revision, mode, funds, events, estimates, actuals, result };
}

/** Events in the active revision coming up (for Home and the reserve horizon); hypothetical revisions never count. */
export function upcomingPlanEvents(from: string, to: string) {
  const out: { eventId: string; label: string; kind: PlanEventKind; date: string; year: number }[] = [];
  for (const y of listYears()) {
    if (!y.activeRevisionId) continue;
    const ests = db().select().from(schema.finEventEstimates).where(eq(schema.finEventEstimates.revisionId, y.activeRevisionId)).all();
    const events = db().select().from(schema.finEvents).where(eq(schema.finEvents.year, y.year)).all();
    for (const e of ests) {
      const ev = events.find((x) => x.id === e.eventId);
      if (!ev || e.removed || ev.status === "complete" || e.date < from || e.date > to) continue;
      out.push({ eventId: ev.id, label: ev.label, kind: ev.kind as PlanEventKind, date: e.date, year: y.year });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Check-in actions may only link to events in an active revision. */
export function assertLinkableEvent(eventId: string) {
  const ev = db().select().from(schema.finEvents).where(eq(schema.finEvents.id, eventId)).get() ?? notFound("Plan event");
  const active = activeRevisionId(ev.year);
  const est =
    active &&
    db()
      .select()
      .from(schema.finEventEstimates)
      .where(and(eq(schema.finEventEstimates.revisionId, active), eq(schema.finEventEstimates.eventId, eventId)))
      .get();
  if (!est || est.removed) throw new HttpError(409, "not_active", "That event isn't in the active plan, so a check-in can't use it.");
}

/* ------------------------------------------------------------- comments */

export function listComments(targetType: string, targetId: string) {
  return db()
    .select()
    .from(schema.finComments)
    .where(and(eq(schema.finComments.targetType, targetType), eq(schema.finComments.targetId, targetId)))
    .orderBy(asc(schema.finComments.createdAt))
    .all();
}

export function addComment(targetType: string, targetId: string, body: string, actor: string, correlationId: string) {
  const id = newId("fcm");
  db().insert(schema.finComments).values({ id, targetType, targetId, userId: actor, body: body.trim() }).run();
  auditFinance(actor, "finance.comment", `${targetType}:${targetId}`, null, { id }, correlationId);
  return id;
}

/* ------------------------------------------------- spreadsheet migration */

/**
 * Import one Yearly Projections block (exported as CSV) as a hypothetical
 * revision marked "imported, unreconciled", with provenance. Columns:
 * date,label,kind,incoming,<fund>,<fund>…  Rows "Starting Position" and
 * "Goal" set openings and goals. A person promotes it after review (Q5).
 */
export function importProjectionBlock(
  input: { year: number; name: string; tab: string; block: string; range: string; csv: string },
  actor: string,
  correlationId: string,
) {
  const rows = csvObjects(input.csv);
  if (!rows.length) throw new HttpError(400, "empty", "The block has no rows.");
  const reserved = new Set(["line", "date", "label", "kind", "incoming"]);
  const fundCols = Object.keys(rows[0]!).filter((k) => !reserved.has(k));
  const existing = listFunds(true);
  const created: string[] = [];
  const fundFor = new Map<string, string>();
  for (const col of fundCols) {
    const name = col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const f = existing.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]+/g, "_") === col);
    fundFor.set(col, f?.id ?? createFund({ name }, actor, correlationId));
    if (!f) created.push(name);
  }
  ensureYear(input.year, actor, correlationId);
  const importedAt = new Date().toISOString();
  const provenance = { tab: input.tab, block: input.block, range: input.range, importedAt };
  const revisionId = createRevision(
    input.year,
    { name: input.name, changeNote: `Imported from “${input.tab}” ${input.block} (${input.range}); unreconciled`, provenance },
    actor,
    correlationId,
  );
  // Start from nothing: the imported block is the whole revision.
  db().delete(schema.finEventEstimates).where(eq(schema.finEventEstimates.revisionId, revisionId)).run();
  const errors: { line: number; message: string }[] = [];
  let events = 0;
  for (const r of rows) {
    try {
      const label = (r.label ?? "").trim();
      const money = (k: string) => (r[k] ? parseMoney(r[k]!) : 0);
      if (/^starting position$/i.test(label) || /^goal$/i.test(label)) {
        for (const col of fundCols) {
          if (!r[col]) continue;
          const fundId = fundFor.get(col)!;
          const cur = db()
            .select()
            .from(schema.finRevisionFunds)
            .where(and(eq(schema.finRevisionFunds.revisionId, revisionId), eq(schema.finRevisionFunds.fundId, fundId)))
            .get();
          setOpening(
            revisionId,
            fundId,
            /^goal$/i.test(label)
              ? { opening: cur?.opening ?? 0, goal: money(col) }
              : { opening: money(col), goal: cur?.goal ?? null, rolloverNote: "Imported starting position" },
            actor,
            correlationId,
          );
        }
        continue;
      }
      if (!label || /^(change|ending position|diff from goal)$/i.test(label)) continue;
      const allocations = Object.fromEntries(fundCols.filter((c) => r[c]).map((c) => [fundFor.get(c)!, money(c)]));
      const kindRaw = (r.kind ?? "").toLowerCase();
      const amount = r.incoming ? money("incoming") : Object.values(allocations).reduce((s, v) => s + v, 0);
      const kind: PlanEventKind =
        kindRaw === "reallocation" || kindRaw === "income" || kindRaw === "obligation" ? kindRaw : amount >= 0 ? "income" : "obligation";
      createEvent(revisionId, { label, kind, date: parseDate(r.date ?? ""), amount, allocations }, actor, correlationId, {
        imported: true,
        provenance: { ...provenance, row: String(r.line) },
      });
      events++;
    } catch (err) {
      errors.push({ line: r.line, message: (err as Error).message });
    }
  }
  return { revisionId, events, createdFunds: created, errors };
}
