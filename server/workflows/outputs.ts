import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import type { CurrentUser } from "@/server/auth";
import { runStructured } from "@/integrations/hermes/structured";
import { createItem } from "@/server/work/store";
import { getPreferences } from "@/server/settings";
import { notify } from "@/server/notifications";
import { localDate, localMinutes } from "@/lib/time";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { formToOps, validateForm, validateOps, type Capture, type CaptureOp } from "@/lib/workflows/runs";
import {
  DEFAULT_REMINDER,
  editSessionOps,
  filterHistory,
  filterOptions,
  historyRow,
  markdownFileName,
  promotePlan,
  reminderDue,
  reminderFromDefinition,
  runMarkdown,
  runStats,
  type HistoryFilter,
  type ReminderSchedule,
} from "@/lib/workflows/outputs";
import { currentDefinition } from "./store";
import { endRun, getRun, ownRun, parseJson, patchRun, saveRun, type RunCtx } from "./runs";

/**
 * Workflows W4 outputs. Everything that leaves the run is a confirmed write
 * (work items) or a local download (Markdown). The summary is an agent DRAFT
 * stored as `proposed` until the owner accepts it. Ending never settles.
 */

const db = () => getDb();
const TZ = () => getPreferences().timezone || process.env.TZ || "America/Chicago";

/* ---------------- Summary (agent draft → owner accepts) ---------------- */

const summarySchema = z.object({ summary: z.string().min(1).max(4000) });

export async function proposeSummary(user: CurrentUser, ctx: RunCtx, id: string) {
  const { row, def } = ownRun(ctx.userId, id);
  const capture = parseJson<Capture>(row.captureJson, {});
  const task = [
    `End-of-session summary for the Jarvis workflow "${def.name}".`,
    def.outputs?.summary?.instructions ?? "Write a short summary (≤ 5 lines) of the notes below. No added commentary.",
    "Use only the notes; never add outside content.",
    "<notes>",
    runMarkdown(def, { title: row.title, startedAt: row.startedAt, capture }).slice(0, 12000),
    "</notes>",
    'Reply with ONE JSON object: {"summary":"…"}.',
  ].join("\n");
  const out = await runStructured({
    source: "workflow_summary",
    label: "Workflow summary",
    task,
    schema: summarySchema,
    example: { summary: "…" },
    interactive: true,
  });
  saveRun(row, { summary: out.summary.trim(), summaryState: "proposed" });
  audit({ actor: user.id, action: "workflow.run.summary.propose", sourceRecord: id, result: "ok", correlationId: ctx.correlationId });
  return getRun(ctx.userId, id);
}

/** Owner accepts (optionally edited) or clears the summary. Local run state. */
export function setSummary(ctx: RunCtx, id: string, input: { summary: string | null }) {
  const { row } = ownRun(ctx.userId, id);
  const text = input.summary?.trim() ?? "";
  saveRun(row, text ? { summary: text.slice(0, 4000), summaryState: "accepted" } : { summary: null, summaryState: "none" });
  audit({
    actor: ctx.userId,
    action: "workflow.run.summary.accept",
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { cleared: !text },
  });
  return getRun(ctx.userId, id);
}

/* ---------------- End form + end session ---------------- */

/** Form answers are filed whole or not at all: a dropped op means the answer would silently vanish (#147/#148). */
function rejectDropped(def: WorkflowDefinition, captureJson: string, ops: CaptureOp[]) {
  if (!ops.length) return;
  const v = validateOps(def, parseJson<Capture>(captureJson, {}), ops);
  if (!v.dropped.length) return;
  throw Object.assign(new HttpError(422, "invalid_form", "Some answers couldn't be saved. Check them and try again."), {
    details: { dropped: v.dropped.map((d) => ({ path: (d.op as { path?: unknown } | null)?.path ?? null, reason: d.reason })) },
  });
}

/** End session: optional end-form values are filed first (local, undoable), then the run ends. Never settles. */
export function endWithForm(ctx: RunCtx, id: string, values: Record<string, unknown> | undefined) {
  const { row, def } = ownRun(ctx.userId, id);
  if (row.status === "live" && values && Object.keys(values).length) {
    const errors = validateForm(def, "end", values);
    if (errors.length) throw Object.assign(new HttpError(422, "invalid_form", errors[0].message), { details: { errors } });
    const ops = formToOps(def, "end", values);
    // #147: every answer must be filed before the run ends; if any would be dropped, keep the run live
    rejectDropped(def, row.captureJson, ops);
    if (ops.length) patchRun(ctx, id, { by: "user", ops, source: "form:end" });
  }
  return endRun(ctx, id);
}

/* ---------------- Reflection prompt (D10: only on "Prompt me") ---------------- */

const reflectionSchema = z.object({ prompt: z.string().min(1).max(280) });

/** One reflection question drawn from the run's own notes. A proposal: nothing is filed until the owner answers. */
export async function reflectionPrompt(user: CurrentUser, ctx: RunCtx, id: string) {
  const { row, def } = ownRun(ctx.userId, id);
  if (def.reflectionPrompts === "off" || !def.reflectionPrompts) throw new HttpError(409, "reflection_off", "Reflection prompts are off for this workflow");
  const capture = parseJson<Capture>(row.captureJson, {});
  const out = await runStructured({
    source: "workflow_reflection",
    label: "Workflow reflection prompt",
    task: [
      "Ask ONE short reflection question (≤ 280 chars) drawn only from these notes. No outside commentary.",
      "<notes>",
      runMarkdown(def, { title: row.title, startedAt: row.startedAt, capture }).slice(0, 8000),
      "</notes>",
      'Reply with ONE JSON object: {"prompt":"…"}.',
    ].join("\n"),
    schema: reflectionSchema,
    example: { prompt: "…" },
    interactive: true,
  });
  audit({ actor: user.id, action: "workflow.run.reflection", sourceRecord: id, result: "ok", correlationId: ctx.correlationId });
  return { prompt: out.prompt.trim() };
}

/* ---------------- Markdown export ---------------- */

export function exportMarkdown(userId: string, id: string) {
  const { row, def } = ownRun(userId, id);
  const markdown = runMarkdown(def, {
    title: row.title,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    capture: parseJson<Capture>(row.captureJson, {}),
    summary: row.summaryState === "accepted" ? row.summary : null,
  });
  return { fileName: markdownFileName(def, row.startedAt), markdown };
}

/* ---------------- Action checklist → work items (confirmed) ---------------- */

export const promoteBody = z
  .object({
    indices: z.array(z.number().int().min(0)).min(1).max(20),
    parentId: z.string().min(1).max(64),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    /** the titles the owner saw in the confirm sheet: must match exactly */
    titles: z.array(z.string().max(200)).min(1).max(20),
  })
  .strict();

export function promoteActions(user: CurrentUser, ctx: RunCtx, id: string, body: z.infer<typeof promoteBody>) {
  const { row, def } = ownRun(ctx.userId, id);
  const capture = parseJson<Capture>(row.captureJson, {});
  const plan = promotePlan(def, capture, body.indices, { parent: body.parentId, due: body.due ?? null });
  if (!plan.length) throw new HttpError(422, "nothing_to_create", "Pick at least one action");
  if (JSON.stringify(plan.map((p) => p.title)) !== JSON.stringify(body.titles))
    throw new HttpError(409, "stale_plan", "These actions changed since you looked. Review them again.");
  const prior = parseJson<{ index: number; itemId: string; title: string }[]>(row.promotedJson, []);
  // #145: one item per (run, action index, title): a second confirm (other tab, retry after a lost reply) creates nothing
  const key = (x: { index: number; title: string }) => `${x.index}\u0000${x.title}`;
  const done = new Set(prior.map(key));
  const already = prior.filter((x) => plan.some((p) => key(p) === key(x)));
  const created: { index: number; itemId: string; title: string }[] = [];
  for (const p of plan) {
    if (done.has(key(p))) continue;
    done.add(key(p));
    // createItem enforces caps, the Finance/aiPolicy rules of the parent, and audits each create
    const item = createItem(user, { parentId: body.parentId, kind: "thread", title: p.title, targetDate: p.due }, ctx.correlationId);
    created.push({ index: p.index, itemId: item.id, title: p.title });
  }
  if (!created.length) return { run: getRun(ctx.userId, id), created, already };
  saveRun(row, { promotedJson: JSON.stringify([...prior, ...created].slice(-200)) });
  audit({
    actor: ctx.userId,
    action: "workflow.items.promote",
    sourceRecord: id,
    result: "ok",
    correlationId: ctx.correlationId,
    detail: { created: created.length, parentId: body.parentId },
  });
  return { run: getRun(ctx.userId, id), created, already };
}

/* ---------------- Edit session (#132) ---------------- */

export function editSession(ctx: RunCtx, id: string, values: Record<string, unknown>) {
  const { row, def } = ownRun(ctx.userId, id);
  const errors = validateForm(def, "mid", values).filter((e) => e.field in values);
  if (errors.length) throw Object.assign(new HttpError(422, "invalid_form", errors[0].message), { details: { errors } });
  const ops = editSessionOps(def, parseJson<Capture>(row.captureJson, {}), values);
  rejectDropped(def, row.captureJson, ops);
  if (!ops.length) return { run: getRun(ctx.userId, id), applied: [] as string[], dropped: 0, proposed: 0 };
  return patchRun(ctx, id, { by: "user", ops, source: "form:mid" });
}

/* ---------------- History + stats ---------------- */

function ownWorkflowDef(userId: string, workflowId: string): { def: WorkflowDefinition; row: typeof schema.workflows.$inferSelect } {
  const row = db()
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.ownerId, userId)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That workflow isn't here");
  const def = currentDefinition(row.id, row.currentVersion);
  if (!def) throw new HttpError(409, "invalid_definition", "That workflow's definition is missing");
  return { def, row };
}

export function workflowHistory(userId: string, workflowId: string, filter: HistoryFilter = {}) {
  const { def } = ownWorkflowDef(userId, workflowId);
  const t = schema.workflowRuns;
  const runs = db()
    .select({ id: t.id, title: t.title, status: t.status, startedAt: t.startedAt, conversationId: t.conversationId, captureJson: t.captureJson })
    .from(t)
    .where(and(eq(t.ownerId, userId), eq(t.workflowId, workflowId)))
    .orderBy(desc(t.startedAt))
    .limit(500)
    .all();
  const rows = runs.map((r) => historyRow(def, { ...r, capture: parseJson<Capture>(r.captureJson, {}) }));
  const today = localDate(new Date(), TZ());
  return { rows: filterHistory(rows, filter).slice(0, 50), total: rows.length, options: filterOptions(rows), stats: runStats(rows, today, 12) };
}

/* ---------------- Reminder schedule (D6: remind only) ---------------- */

export const reminderBody = z
  .object({
    enabled: z.boolean(),
    day: z.number().int().min(0).max(6).optional(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  })
  .strict();

export function getReminder(userId: string, workflowId: string): ReminderSchedule & { declared: boolean } {
  const { def } = ownWorkflowDef(userId, workflowId);
  const declared = reminderFromDefinition(def);
  const row = db().select().from(schema.workflowReminders).where(eq(schema.workflowReminders.workflowId, workflowId)).get();
  const base = declared ?? DEFAULT_REMINDER;
  return row ? { enabled: row.enabled, day: row.day, time: row.time, declared: !!declared } : { ...base, enabled: false, declared: !!declared };
}

export function setReminder(ctx: RunCtx, workflowId: string, body: z.infer<typeof reminderBody>) {
  const cur = getReminder(ctx.userId, workflowId);
  const next = { enabled: body.enabled, day: body.day ?? cur.day, time: body.time ?? cur.time };
  db()
    .insert(schema.workflowReminders)
    .values({ workflowId, ownerId: ctx.userId, ...next, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.workflowReminders.workflowId, set: { ...next, updatedAt: new Date().toISOString() } })
    .run();
  audit({ actor: ctx.userId, action: "workflow.reminder.set", sourceRecord: workflowId, result: "ok", correlationId: ctx.correlationId, detail: next });
  return getReminder(ctx.userId, workflowId);
}

/**
 * Dispatcher task: for each enabled reminder that is due in the owner's
 * timezone, queue ONE notification linking to `/<slug>` start. Never starts
 * a run, never calls a model.
 */
export function sendDueReminders(now = new Date()) {
  const tz = TZ();
  const date = localDate(now, tz);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const local = { date, weekday, minutes: localMinutes(now, tz) };
  const rows = db()
    .select({ r: schema.workflowReminders, w: schema.workflows })
    .from(schema.workflowReminders)
    .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowReminders.workflowId))
    .where(and(eq(schema.workflowReminders.enabled, true), eq(schema.workflows.status, "active")))
    .all();
  let sent = 0;
  for (const { r, w } of rows) {
    if (!reminderDue({ enabled: r.enabled, day: r.day, time: r.time }, local, r.lastSentDate)) continue;
    db().update(schema.workflowReminders).set({ lastSentDate: date }).where(eq(schema.workflowReminders.workflowId, r.workflowId)).run();
    notify(
      {
        type: "workflow_reminder",
        category: "info",
        severity: "normal",
        title: `${w.name} — start?`,
        body: "Tap to open the start form. Nothing starts until you do.",
        source: "jarvis",
        deepLink: `/workflows?start=${encodeURIComponent(w.slug)}`,
        dedupeKey: `workflow_reminder:${w.id}:${date}`,
      },
      r.ownerId,
    );
    sent++;
  }
  return sent;
}
