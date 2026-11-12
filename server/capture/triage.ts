import "server-only";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId, sha256 } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { userById, type CurrentUser } from "@/server/auth";
import { getPreferences, getSetting, setSetting } from "@/server/settings";
import { hooks, fireHook } from "@/server/hooks";
import { withVia } from "@/server/work/actor";
import { createItem, updateItem } from "@/server/work/store";
import { raiseDecision } from "@/server/work/decision-store";
import { finishRegisteredRun, registerAgentRun } from "@/server/work/registered-runs";
import { recordWrite, undoWrite } from "@/server/skylight-writes";
import { assertSkylightWritable, runSkylightWrite } from "@/integrations/skylight/write";
import { getAiSettings } from "@/server/ai/settings";
import { triageSkylightLists } from "@/server/ai/context";
import { areaOf, enqueue } from "@/server/ai/jobs";
import { effectiveAreaPolicy } from "@/server/ai/rules";
import { moveCaptureToItem } from "@/server/capture";
import { readChosen, readPlan, toView, writeUndoable, type Row } from "./triage-views";

export { triageForItem, triageViewsForInbox } from "./triage-views";
import { captureActions } from "@/lib/ai";
import { localTimeToInstant } from "@/lib/time";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { actionKey, decideTriage, describeAction, doneText, type CaptureTriageView, type ResolvedAction, type TriageOutcome } from "@/lib/capture-triage";

/**
 * Capture AI triage, the applier (owner request 2026-11-12; contract lib/capture-triage.ts).
 * The AI runner stores the validated action of a capture's triage (capture_triage row, `planned`);
 * this module gates it (decideTriage) and acts through the SAME write paths as the UI:
 * Skylight writes via runSkylightWrite + recordWrite (skylight_writes row = Undo, audit
 * `skylight.write`, 12 writes/min), Jarvis items via createItem/updateItem (work_ops = Activity
 * Undo), decisions via raiseDecision (D-n). Every action runs inside withVia("agent:<profile>")
 * and is recorded as an agent run (R-n), so it shows in Activity and Chief of staff.
 * Never settles anything: a handled capture becomes a ready_to_settle item the owner settles.
 */

const C = schema.captureTriage;
const I = schema.workInbox;
const nowIso = () => new Date().toISOString();
/** an `applying` row older than this was interrupted (restart): never re-run its write blindly */
const STALE_APPLY_MS = 5 * 60_000;

function ownedRow(userId: string, id: string) {
  const r = getDb().select().from(C).where(eq(C.id, id)).get();
  if (!r || r.userId !== userId) throw new HttpError(404, "not_found", "Not found");
  return r;
}

function setRow(id: string, patch: Partial<Row>) {
  getDb()
    .update(C)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(C.id, id))
    .run();
  return getDb().select().from(C).where(eq(C.id, id)).get()!;
}

// --- Apply ---

const agentVia = (r: Row) => `agent:${(r.profile ?? "jarvis").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "jarvis"}`;

/** The capture's destination: its triage suggestion when owned, open and AI-allowed; else Miscellaneous (null). */
function destination(userId: string, entry: typeof I.$inferSelect): string | null {
  const id = entry.suggestedParentId;
  if (!id) return null;
  const row = getDb()
    .select()
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, id), eq(schema.workItems.userId, userId)))
    .get();
  if (!row || row.archived) return null;
  // Excluded and triage-only areas never receive items Jarvis made on its own.
  return effectiveAreaPolicy(areaOf(userId, id)) === "allowed" ? id : null;
}

function skylightOp(a: Extract<ResolvedAction, { type: "skylight_list_add" | "skylight_event_create" }>): SkylightWriteOp {
  if (a.type === "skylight_list_add") return { op: "list.add", listId: a.listId, listLabel: a.listLabel, label: a.label };
  const tz = getPreferences().timezone;
  if (a.allDay || !a.time) {
    const next = new Date(Date.parse(`${a.date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return { op: "event.create", event: { summary: a.summary, allDay: true, startsAt: a.date, endsAt: next, location: a.location } };
  }
  const start = localTimeToInstant(a.date, a.time, tz);
  const end = new Date(start.getTime() + a.durationMinutes * 60_000);
  return { op: "event.create", event: { summary: a.summary, allDay: false, startsAt: start.toISOString(), endsAt: end.toISOString(), location: a.location } };
}

const SUGGEST_WHY: Record<Extract<TriageOutcome, { kind: "suggest" }>["reason"], string> = {
  risky: "Jarvis only suggests this; do it yourself if it's right.",
  not_allowed: "Auto-handle is off for this kind of action.",
  triage_only: "Captures are set to triage only.",
  low_confidence: "Not sure enough to do it alone.",
  backfill: "Captured before auto-handle; tap Do it if it's right.",
  no_list: "Connect Skylight lists to do this.",
};

/** Owner-visible title of the item a capture becomes. */
function itemTitle(entry: typeof I.$inferSelect, a: ResolvedAction | null) {
  if (a?.type === "skylight_list_add") return a.label;
  if (a?.type === "skylight_event_create") return a.summary;
  if (a?.type === "jarvis_task") return a.title;
  return (entry.suggestedTitle || entry.title).slice(0, 200);
}

function acceptInto(entry: typeof I.$inferSelect, itemId: string) {
  getDb().update(I).set({ acceptedAt: nowIso(), acceptedItemId: itemId, updatedAt: nowIso() }).where(eq(I.id, entry.id)).run();
  moveCaptureToItem(entry, itemId);
}

function recordRun(user: CurrentUser, r: Row, itemId: string, title: string, summary: string, correlationId: string) {
  const profile = agentVia(r).slice(6);
  const run = registerAgentRun(
    user,
    profile,
    { itemId, title: `Capture triage: ${title}`.slice(0, 200), delegationId: `capture:${r.inboxId}`.slice(0, 200) },
    correlationId,
  );
  finishRegisteredRun(user, run.runId, "done", summary.slice(0, 2000), new Date());
  return run.runId;
}

/** Claim and apply due planned rows (dispatcher task + hook). Never throws. */
export async function applyPlannedTriage(now = new Date(), limit = 4) {
  const db = getDb();
  // Interrupted applies (restart mid-write): fail them so the owner can Retry, rather than re-running a write blindly.
  const stale = new Date(now.getTime() - STALE_APPLY_MS).toISOString();
  for (const r of db
    .select()
    .from(C)
    .where(and(eq(C.state, "applying"), lte(C.updatedAt, stale)))
    .all())
    setRow(r.id, { state: "failed", errorCode: "interrupted", summary: "Interrupted while handling this capture. Check Skylight, then Retry." });
  const due = db
    .select()
    .from(C)
    .where(and(eq(C.state, "planned"), lte(C.notBefore, now.toISOString())))
    .limit(limit)
    .all();
  for (const r of due) {
    const claimed = db
      .update(C)
      .set({ state: "applying", attempts: r.attempts + 1, updatedAt: nowIso() })
      .where(and(eq(C.id, r.id), eq(C.state, "planned")))
      .run();
    if (claimed.changes !== 1) continue;
    try {
      await applyOne(db.select().from(C).where(eq(C.id, r.id)).get()!);
    } catch (e) {
      const err = e as HttpError & { status?: number };
      // Skylight's 12 writes/min budget is shared with the UI: wait and try again.
      if (err.status === 429 && r.attempts < 5)
        setRow(r.id, { state: "planned", notBefore: new Date(Date.now() + 65_000).toISOString(), errorCode: "rate_limited" });
      else
        setRow(r.id, {
          state: "failed",
          errorCode: (typeof err.code === "string" ? err.code : "failed").slice(0, 40),
          summary: "Couldn't handle this capture.",
        });
      audit({
        actor: r.userId,
        action: "capture.triage",
        source: "capture",
        sourceRecord: r.inboxId,
        result: "error",
        correlationId: r.id,
        detail: { code: err.code ?? null },
      });
    }
  }
  return due.length;
}

async function applyOne(r: Row) {
  const db = getDb();
  const user = userById(r.userId);
  const entry = db.select().from(I).where(eq(I.id, r.inboxId)).get();
  const chosen = readChosen(r);
  if (!user || !entry || entry.dismissedAt || (entry.acceptedItemId && !chosen && entry.acceptedItemId !== r.itemId))
    return void setRow(r.id, { state: "skipped", summary: "Handled by hand" });
  if (entry.acceptedItemId && effectiveAreaPolicy(areaOf(user.id, entry.acceptedItemId)) === "excluded")
    return void setRow(r.id, { state: "skipped", summary: "AI is off for this area" });
  const settings = captureActions(getAiSettings());
  const plan = readPlan(r);
  const outcome: TriageOutcome = chosen
    ? { kind: "auto", action: chosen }
    : decideTriage(plan.action, {
        settings,
        lists: triageSkylightLists(),
        title: entry.title,
        text: [entry.title, entry.note].join("\n"),
        backfill: r.backfill,
      });
  const via = agentVia(r);
  const correlationId = r.id;
  if (outcome.kind === "skip") return void setRow(r.id, { state: "skipped" });
  if (outcome.kind === "suggest")
    return void setRow(r.id, { state: "suggested", summary: `Suggested: ${outcome.summary.replace(/\.$/, "")}. ${SUGGEST_WHY[outcome.reason]}`.slice(0, 400) });
  // A note/idea keeps the existing one-tap filing suggestion (and its investigation); nothing is moved for the owner.
  if (outcome.kind === "file") return void setRow(r.id, { state: "skipped", summary: outcome.summary });
  if (outcome.kind === "needs_input") {
    const title = (plan.action?.label || plan.action?.event?.summary || itemTitle(entry, null)).slice(0, 200);
    const item = r.itemId
      ? { id: r.itemId }
      : withVia(via, () =>
          createItem(
            user,
            { kind: "thread", parentId: destination(user.id, entry), title, summary: entry.note, nextAction: "Answer the question" },
            correlationId,
          ),
        );
    if (!r.itemId) setRow(r.id, { itemId: item.id });
    const d = withVia(via, () =>
      raiseDecision(
        user.id,
        item.id,
        {
          question: outcome.question.slice(0, 500),
          choices: outcome.choices.map((c) => c.label),
          ...(outcome.recommended ? { recommended: outcome.recommended } : {}),
          pack: {
            why: `From your capture “${entry.title.slice(0, 200)}”. Jarvis won't guess dates or times.`.slice(0, 600),
            facts: [
              { label: "Captured", value: entry.title.slice(0, 400) },
              ...(outcome.missing.length ? [{ label: "Missing", value: outcome.missing.join(", ").slice(0, 400) }] : []),
            ],
            options: outcome.choices.map((c) => ({ choice: c.label, effect: (c.action ? describeAction(c.action) : "Nothing else happens").slice(0, 400) })),
          },
        },
        { raisedBy: via, correlationId },
      ),
    );
    acceptInto(entry, item.id);
    const summary = `Needs you: ${outcome.question}`.slice(0, 400);
    const runId = recordRun(user, r, item.id, title, `Asked ${d.ref}: ${outcome.question}`, correlationId);
    audit({
      actor: via,
      action: "capture.triage",
      source: "capture",
      sourceRecord: r.inboxId,
      result: "ok",
      correlationId,
      detail: { outcome: "needs_input", ref: d.ref },
    });
    return void setRow(r.id, {
      state: "needs_input",
      itemId: item.id,
      decisionId: d.id,
      runId,
      summary,
      planJson: JSON.stringify({ action: plan.action, choices: outcome.choices }).slice(0, 8000),
    });
  }
  // auto
  const a = outcome.action;
  const hash = sha256(`${r.inboxId}:${actionKey(a)}`);
  // Idempotent: the same action on the same capture is written to Skylight at most once (a retry after a
  // failure past the write only finishes the item).
  const written = r.actionHash === hash && !!r.skylightWriteId;
  setRow(r.id, { actionHash: hash });
  let writeId: string | null = written ? r.skylightWriteId : null;
  if (!written && (a.type === "skylight_list_add" || a.type === "skylight_event_create")) {
    const op = skylightOp(a);
    try {
      assertSkylightWritable();
      const result = await withVia(via, () => runSkylightWrite(op, user, { correlationId }));
      const w = withVia(via, () => recordWrite(op, user, result.created));
      writeId = w.id;
      setRow(r.id, { skylightWriteId: writeId });
      audit({
        actor: user.id,
        action: "skylight.write",
        source: "skylight",
        sourceRecord: result.created.itemId ?? result.created.eventId ?? op.op,
        result: "ok",
        correlationId,
        detail: { via, capture: r.inboxId },
      });
    } catch (err) {
      const e = err as { code?: unknown; detail?: unknown };
      audit({
        actor: user.id,
        action: "skylight.write",
        source: "skylight",
        sourceRecord: op.op,
        result: "error",
        correlationId,
        detail: {
          op: op.op,
          via,
          ...(typeof e.code === "string" ? { code: e.code } : {}),
          ...(e.detail && typeof e.detail === "object" ? (e.detail as object) : {}),
        },
      });
      throw err;
    }
    void import("@/server/sources").then((m) => m.refreshSource("skylight")).catch(() => undefined);
  }
  const title = itemTitle(entry, a);
  const done = `Done: ${doneText(a)}.`;
  let itemId = r.itemId;
  if (a.type === "jarvis_task") {
    if (!itemId) {
      const item = withVia(via, () =>
        createItem(user, { kind: "thread", parentId: destination(user.id, entry), title, summary: entry.note, nextAction: a.nextAction }, correlationId),
      );
      itemId = item.id;
      setRow(r.id, { itemId });
    } else withVia(via, () => updateItem(user, itemId!, { nextAction: a.nextAction }, correlationId));
    acceptInto(entry, itemId);
    const summary = `Filed “${title}” as a Jarvis to-do.`;
    const runId = recordRun(user, r, itemId, title, summary, correlationId);
    audit({
      actor: via,
      action: "capture.triage",
      source: "capture",
      sourceRecord: r.inboxId,
      result: "ok",
      correlationId,
      detail: { outcome: "filed", itemId },
    });
    return void setRow(r.id, { state: "filed", itemId, runId, summary, chosenJson: r.chosenJson ?? JSON.stringify(a) });
  }
  const body = [
    done,
    `You captured “${entry.title}”. If that's wrong, Undo it here or correct it in Skylight. Jarvis never settles: settle it when you're happy.`,
  ].join("\n\n");
  if (!itemId) {
    const item = withVia(via, () => createItem(user, { kind: "thread", parentId: destination(user.id, entry), title, summary: body }, correlationId));
    itemId = item.id;
    setRow(r.id, { itemId });
  } else withVia(via, () => updateItem(user, itemId!, { summary: body }, correlationId));
  withVia(via, () =>
    updateItem(user, itemId!, { status: "ready_to_settle", reason: done.slice(0, 500), nextAction: "Check it, then settle (or Undo)" }, correlationId),
  );
  acceptInto(entry, itemId);
  const runId = recordRun(user, r, itemId, title, done, correlationId);
  audit({
    actor: via,
    action: "capture.triage",
    source: "capture",
    sourceRecord: r.inboxId,
    result: "ok",
    correlationId,
    detail: { outcome: "done", itemId, writeId },
  });
  setRow(r.id, { state: "done", itemId, runId, summary: done.slice(0, 400), chosenJson: r.chosenJson ?? JSON.stringify(a) });
}

// --- Owner controls ---

/** Undo the external write of a handled capture; the item goes back to captured (never deleted). */
export async function undoTriage(user: CurrentUser, id: string, correlationId: string) {
  const r = ownedRow(user.id, id);
  if (r.state !== "done" || !writeUndoable(r.skylightWriteId)) throw new HttpError(409, "not_undoable", "That can't be undone anymore.");
  await undoWrite(r.skylightWriteId!, user, { correlationId });
  audit({
    actor: user.id,
    action: "skylight.write",
    source: "skylight",
    sourceRecord: r.skylightWriteId!,
    result: "ok",
    correlationId,
    detail: { undo: true, capture: r.inboxId },
  });
  const a = readChosen(r);
  const what = a ? describeAction(a) : "the change";
  if (r.itemId)
    updateItem(
      user,
      r.itemId,
      { status: "captured", reason: `Undone: ${what}`.slice(0, 500), nextAction: "Undone. Decide what to do with this capture" },
      correlationId,
    );
  void import("@/server/sources").then((m) => m.refreshSource("skylight")).catch(() => undefined);
  return toView(setRow(r.id, { state: "undone", summary: `Undone: ${what}.`.slice(0, 400) }));
}

/** Retry a failed triage: re-apply the stored action, or run the AI triage again when there is none. `id` = triage row id or inbox id. */
export function retryTriage(user: CurrentUser, id: string, correlationId: string) {
  const db = getDb();
  const r = db.select().from(C).where(eq(C.id, id)).get() ?? db.select().from(C).where(eq(C.inboxId, id)).get();
  if (r && r.userId !== user.id) throw new HttpError(404, "not_found", "Not found");
  if (r && r.state !== "failed") throw new HttpError(409, "not_failed", "Nothing to retry");
  if (r && readPlan(r).action) {
    const next = setRow(r.id, { state: "planned", errorCode: null, notBefore: nowIso() });
    fireHook("triagePlanned");
    return toView(next);
  }
  const inboxId = r?.inboxId ?? id;
  const entry = db
    .select()
    .from(I)
    .where(and(eq(I.id, inboxId), eq(I.userId, user.id)))
    .get();
  if (!entry || entry.source !== "capture") throw new HttpError(404, "not_found", "Capture not found");
  enqueue({
    userId: user.id,
    kind: "triage",
    subjectType: "inbox",
    subjectId: inboxId,
    clientKey: newId("rt").replace(/[^A-Za-z0-9_-]/g, ""),
    params: { investigateMode: "triage_only", ...(r?.backfill ? { backfill: true } : {}) },
    background: true,
    correlationId,
  });
  db.update(I).set({ triageState: "queued" }).where(eq(I.id, inboxId)).run();
  // Held until the new triage job re-plans it (runner planCaptureAction), so the applier doesn't pick it up first.
  if (r)
    setRow(r.id, { state: "planned", errorCode: "retrying", summary: "Triaging again…", notBefore: new Date(Date.now() + 365 * 86_400_000).toISOString() });
  void import("@/server/ai/runner").then((m) => m.kickRunner()).catch(() => undefined);
  return r
    ? toView(db.select().from(C).where(eq(C.id, r.id)).get()!)
    : ({
        id: inboxId,
        inboxId,
        state: "planned",
        summary: "Triaging again…",
        itemId: null,
        decisionRef: null,
        runRef: null,
        undoable: false,
        openHref: null,
        openLabel: null,
        error: null,
        at: nowIso(),
      } satisfies CaptureTriageView);
}

/** "Do it" on a suggestion that Jarvis could do (owner's explicit confirm; risky types never). */
export function applySuggestion(user: CurrentUser, id: string) {
  const r = ownedRow(user.id, id);
  if (r.state !== "suggested") throw new HttpError(409, "not_suggested", "Nothing to do");
  const entry = getDb().select().from(I).where(eq(I.id, r.inboxId)).get();
  if (!entry) throw new HttpError(404, "not_found", "Capture not found");
  const out = decideTriage(readPlan(r).action, {
    settings: captureActions(getAiSettings()),
    lists: triageSkylightLists(),
    title: entry.title,
    text: [entry.title, entry.note].join("\n"),
    chosen: true,
  });
  if (out.kind !== "auto") throw new HttpError(409, "not_applicable", "Jarvis can't do this one for you");
  const next = setRow(r.id, { state: "planned", chosenJson: JSON.stringify(out.action), notBefore: nowIso() });
  fireHook("triagePlanned");
  return toView(next);
}

/** The owner answered a decision this module raised: run the matching choice (consent), else just record it. */
export function onDecisionAnswered(d: { userId: string; decisionId: string; answer: string }) {
  const r = getDb()
    .select()
    .from(C)
    .where(and(eq(C.userId, d.userId), eq(C.decisionId, d.decisionId)))
    .get();
  if (!r || r.state !== "needs_input") return;
  const choice = (readPlan(r).choices ?? []).find((c) => c.label.trim().toLowerCase() === d.answer.trim().toLowerCase());
  if (choice?.action) {
    setRow(r.id, { state: "planned", chosenJson: JSON.stringify(choice.action), notBefore: nowIso() });
    fireHook("triagePlanned");
  } else setRow(r.id, { state: "filed", summary: `Answered: ${d.answer}`.slice(0, 400) });
}

// --- Back-fill ---

const BACKFILL_KEY = "capture_triage:backfill:v1";

/**
 * Once: triage open captures of the last 14 days. Back-filled rows only act when the capture names the
 * target (e.g. "… on Skylight"); everything else becomes a suggestion, so nothing surprising happens.
 */
export function backfillCaptureTriage(now = new Date()) {
  if (getSetting<string>(BACKFILL_KEY)) return { queued: 0 };
  const ai = getAiSettings();
  if (!ai.enabled || !captureActions(ai).autoHandle) return { queued: 0 };
  const db = getDb();
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const rows = db
    .select()
    .from(I)
    .where(and(eq(I.source, "capture"), eq(I.state, "open"), isNull(I.dismissedAt), isNull(I.acceptedAt), gte(I.createdAt, since)))
    .all();
  let queued = 0;
  for (const e of rows) {
    if (e.sensitivity === "credentials" || e.triageState === "queued") continue;
    if (db.select({ id: C.id }).from(C).where(eq(C.inboxId, e.id)).get()) continue;
    const user = userById(e.userId);
    if (!user?.capabilities.has("work.ai")) continue;
    try {
      enqueue({
        userId: e.userId,
        kind: "triage",
        subjectType: "inbox",
        subjectId: e.id,
        clientKey: `bf1${e.id.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`,
        params: { investigateMode: "triage_only", backfill: true },
        background: true,
        correlationId: `capture-backfill:${e.id}`,
      });
      db.update(I).set({ triageState: "queued" }).where(eq(I.id, e.id)).run();
      queued++;
    } catch {
      /* guard refused (excluded area / credentials): leave it as captured */
    }
  }
  setSetting(BACKFILL_KEY, now.toISOString());
  audit({
    actor: "jarvis",
    action: "capture.triage_backfill",
    source: "capture",
    sourceRecord: "inbox",
    result: "ok",
    correlationId: BACKFILL_KEY,
    detail: { queued },
  });
  if (queued) void import("@/server/ai/runner").then((m) => m.kickRunner()).catch(() => undefined);
  return { queued };
}

/** Startup: hooks + dispatcher tasks (instrumentation.ts). */
export function registerCaptureTriage(register: (name: string, everyMs: number, run: (now: Date) => unknown) => void) {
  let running: Promise<unknown> | null = null;
  const kick = () => {
    if (running) return;
    running = applyPlannedTriage()
      .catch((e) => console.error("[jarvis] capture triage failed", (e as Error).message.slice(0, 200)))
      .finally(() => {
        running = null;
      });
  };
  hooks().triagePlanned = () => setTimeout(kick, 0);
  hooks().decisionAnswered = (d) => onDecisionAnswered(d);
  register("capture_triage_apply", 15_000, () => kick());
  register("capture_triage_backfill", 10 * 60_000, (now) => {
    try {
      backfillCaptureTriage(now);
    } catch (e) {
      console.error("[jarvis] capture back-fill failed", (e as Error).message.slice(0, 200));
    }
  });
}
