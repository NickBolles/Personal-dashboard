import "server-only";
import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { ACTION_SOURCES, type ActionSource, type NextAction } from "@/lib/contracts";
import { ASSIST_CATEGORIES, categoryLabel, MAX_WEIGHT, MIN_WEIGHT, VERDICT_LABELS, type FeedbackVerdict } from "@/lib/attention";
import { addDays, DAY, localDate, startOfLocalDay } from "@/lib/time";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { can, type Capable } from "@/server/access";
import { actionFingerprint } from "@/server/ranking/attention";
import { NOT_HELPFUL_DAYS, type Milestone, type MutedCard } from "@/server/ranking/assists";

/**
 * Per-person Home tuning: feedback rows (immutable), category weights, snoozes
 * (action_prefs.hiddenUntil), separate explicit acknowledgements and saved dates. The
 * ranking reads these through `loadTuning`; nothing here edits source data.
 */

type Viewer = Capable & { id: string };

export const MAX_SNOOZE_DAYS = 90;
export const MAX_MILESTONES = 50;

export type Tuning = {
  weights: Record<string, number>;
  snoozed: Map<string, string>;
  acknowledged: Map<string, string>;
  pinned: Set<string>;
  muted: MutedCard[];
  milestones: Milestone[];
};

export function loadTuning(userId: string, now = new Date()): Tuning {
  const db = getDb();
  const weights = Object.fromEntries(
    db
      .select()
      .from(schema.homeCategoryPrefs)
      .where(eq(schema.homeCategoryPrefs.userId, userId))
      .all()
      .map((r) => [r.category, r.weight]),
  );
  const prefs = db.select().from(schema.actionPrefs).where(eq(schema.actionPrefs.userId, userId)).all();
  const snoozed = new Map(prefs.filter((p) => p.hiddenUntil && new Date(p.hiddenUntil) > now).map((p) => [p.actionId, p.hiddenUntil!]));
  const acknowledged = new Map(prefs.filter((p) => p.acknowledgedUntil && new Date(p.acknowledgedUntil) > now).map((p) => [p.actionId, p.acknowledgedUntil!]));
  const pinned = new Set(prefs.filter((p) => p.pinned).map((p) => p.actionId));
  const muted = db
    .select({
      id: schema.homeFeedback.targetId,
      fingerprint: schema.homeFeedback.fingerprint,
      verdict: schema.homeFeedback.verdict,
      createdAt: schema.homeFeedback.createdAt,
    })
    .from(schema.homeFeedback)
    .where(
      and(
        eq(schema.homeFeedback.userId, userId),
        or(
          eq(schema.homeFeedback.verdict, "wrong_assumption"),
          and(
            eq(schema.homeFeedback.verdict, "not_helpful"),
            gt(schema.homeFeedback.createdAt, new Date(now.getTime() - NOT_HELPFUL_DAYS * DAY).toISOString()),
          ),
        ),
      ),
    )
    .orderBy(desc(schema.homeFeedback.createdAt))
    .all() as MutedCard[];
  return { weights, snoozed, acknowledged, pinned, muted, milestones: listMilestones(userId) };
}

/** Actions the person said were ranked wrong, while they still look the same (due date and title). */
export function demotedActions(actions: NextAction[], muted: MutedCard[]) {
  const wrong = new Set(muted.filter((m) => m.verdict === "wrong_assumption").map((m) => `${m.id}|${m.fingerprint}`));
  return new Set(actions.filter((a) => wrong.has(`${a.id}|${actionFingerprint(a)}`)).map((a) => a.id));
}

// ---------------------------------------------------------------- feedback

export type FeedbackInput = {
  idempotencyKey: string;
  target: { kind: "action" | "assist"; id: string; category: string };
  verdict: FeedbackVerdict;
  correction?: string;
  snoozeUntil?: string;
  provenance: { version: number; fingerprint: string; why: string[]; sources: string[] };
};

export type FeedbackResult = { ok: true; id: string; message: string; duplicate?: boolean };

/** Validates that the person can see what they're reacting to, and that category matches target. */
function checkTarget(user: Viewer, t: FeedbackInput["target"], sourceVisible: (u: Capable, s: ActionSource) => boolean) {
  if (t.kind === "action") {
    const source = t.id.slice(0, t.id.indexOf(":")) as ActionSource;
    if (!ACTION_SOURCES.includes(source)) throw new HttpError(400, "bad_target", "Unknown source");
    if (t.category !== `source:${source}`) throw new HttpError(400, "bad_category", "Category doesn't match the item");
    if (!sourceVisible(user, source)) throw new HttpError(403, "forbidden", "You don't have access to that.");
    return;
  }
  if (!t.id.startsWith("assist:") || !(t.category in ASSIST_CATEGORIES)) throw new HttpError(400, "bad_target", "Unknown suggestion");
}

function defaultSnooze(now: Date, timezone: string) {
  return startOfLocalDay(addDays(localDate(now, timezone), 1), timezone).toISOString();
}

function bumpWeight(userId: string, category: string, delta: number) {
  const db = getDb();
  const cur =
    db
      .select({ w: schema.homeCategoryPrefs.weight })
      .from(schema.homeCategoryPrefs)
      .where(and(eq(schema.homeCategoryPrefs.userId, userId), eq(schema.homeCategoryPrefs.category, category)))
      .get()?.w ?? 0;
  const next = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, cur + delta));
  setCategoryWeight(userId, category, next);
  return { before: cur, after: next };
}

export function recordFeedback(
  user: Viewer,
  input: FeedbackInput,
  opts: { now?: Date; timezone: string; sourceVisible: (u: Capable, s: ActionSource) => boolean },
): FeedbackResult {
  const now = opts.now ?? new Date();
  const db = getDb();
  const existing = db
    .select({ id: schema.homeFeedback.id })
    .from(schema.homeFeedback)
    .where(and(eq(schema.homeFeedback.userId, user.id), eq(schema.homeFeedback.idempotencyKey, input.idempotencyKey)))
    .get();
  if (existing) return { ok: true, id: existing.id, message: "Already noted", duplicate: true };

  checkTarget(user, input.target, opts.sourceVisible);
  let snoozeUntil: string | undefined;
  if (input.verdict === "not_now") {
    snoozeUntil = input.snoozeUntil ?? defaultSnooze(now, opts.timezone);
    const t = new Date(snoozeUntil).getTime();
    if (!(t > now.getTime()) || t - now.getTime() > MAX_SNOOZE_DAYS * DAY) throw new HttpError(400, "bad_snooze", `Pick a time within ${MAX_SNOOZE_DAYS} days`);
    // Settings compares persisted timestamps as text: store a canonical UTC instant.
    snoozeUntil = new Date(t).toISOString();
  }

  const id = newId("hfb");
  const label = categoryLabel(input.target.category);
  let message = "Thanks, noted.";
  db.transaction((tx) => {
    tx.insert(schema.homeFeedback)
      .values({
        id,
        userId: user.id,
        idempotencyKey: input.idempotencyKey,
        targetKind: input.target.kind,
        targetId: input.target.id,
        category: input.target.category,
        verdict: input.verdict,
        correction: input.correction?.trim() || null,
        fingerprint: input.provenance.fingerprint,
        provenance: JSON.stringify(input.provenance),
        snoozeUntil: snoozeUntil ?? null,
        createdAt: now.toISOString(),
      })
      .run();
    if (snoozeUntil) {
      tx.insert(schema.actionPrefs)
        .values({ userId: user.id, actionId: input.target.id, hiddenUntil: snoozeUntil })
        .onConflictDoUpdate({
          target: [schema.actionPrefs.userId, schema.actionPrefs.actionId],
          set: { hiddenUntil: snoozeUntil, updatedAt: now.toISOString() },
        })
        .run();
    }
  });

  switch (input.verdict) {
    case "not_now":
      message = "Hidden for now. Safety alerts always stay visible.";
      break;
    case "less_like_this": {
      const w = bumpWeight(user.id, input.target.category, -1);
      message =
        w.after <= MIN_WEIGHT
          ? `${label} won’t take up Now or Today. Undo in Settings → Home priorities.`
          : `${label} will rank a bit lower. Undo in Settings → Home priorities.`;
      break;
    }
    case "helpful": {
      const w = bumpWeight(user.id, input.target.category, +1);
      message = w.after > w.before ? `Thanks. ${label} will rank a bit higher.` : "Thanks, noted.";
      break;
    }
    case "not_helpful":
      message = input.target.kind === "assist" ? "Thanks. This suggestion won’t come back for two weeks." : "Thanks, noted.";
      break;
    case "wrong_assumption":
      message =
        input.target.kind === "assist" ? "Thanks. This suggestion stays hidden until its data changes." : "Thanks. This stays out of Now until it changes.";
      break;
  }
  return { ok: true, id, message };
}

export function deleteFeedback(userId: string, id: string) {
  const res = getDb()
    .delete(schema.homeFeedback)
    .where(and(eq(schema.homeFeedback.userId, userId), eq(schema.homeFeedback.id, id)))
    .run();
  return res.changes > 0;
}

// ---------------------------------------------------------------- weights & reset

export function setCategoryWeight(userId: string, category: string, weight: number) {
  const db = getDb();
  if (weight === 0) {
    db.delete(schema.homeCategoryPrefs)
      .where(and(eq(schema.homeCategoryPrefs.userId, userId), eq(schema.homeCategoryPrefs.category, category)))
      .run();
    return;
  }
  const updatedAt = new Date().toISOString();
  db.insert(schema.homeCategoryPrefs)
    .values({ userId, category, weight, updatedAt })
    .onConflictDoUpdate({ target: [schema.homeCategoryPrefs.userId, schema.homeCategoryPrefs.category], set: { weight, updatedAt } })
    .run();
}

export type ResetScope = "all" | "weights" | "category" | "snoozes" | "snooze" | "feedback";

export function resetTuning(userId: string, scope: ResetScope, target?: string) {
  const db = getDb();
  const weights = scope === "all" || scope === "weights";
  const snoozes = scope === "all" || scope === "snoozes";
  const feedback = scope === "all" || scope === "feedback";
  if (weights) db.delete(schema.homeCategoryPrefs).where(eq(schema.homeCategoryPrefs.userId, userId)).run();
  if (scope === "category" && target) setCategoryWeight(userId, target, 0);
  if (snoozes || (scope === "snooze" && target)) {
    const where = and(
      eq(schema.actionPrefs.userId, userId),
      or(isNotNull(schema.actionPrefs.hiddenUntil), isNotNull(schema.actionPrefs.acknowledgedUntil)),
      ...(scope === "snooze" ? [eq(schema.actionPrefs.actionId, target!)] : []),
    );
    db.update(schema.actionPrefs).set({ hiddenUntil: null, acknowledgedUntil: null, updatedAt: new Date().toISOString() }).where(where).run();
    // Rows that now hold nothing (not pinned, not hidden) are dropped.
    db.delete(schema.actionPrefs)
      .where(
        and(
          eq(schema.actionPrefs.userId, userId),
          eq(schema.actionPrefs.pinned, false),
          isNull(schema.actionPrefs.hiddenUntil),
          isNull(schema.actionPrefs.acknowledgedUntil),
        ),
      )
      .run();
  }
  if (feedback) db.delete(schema.homeFeedback).where(eq(schema.homeFeedback.userId, userId)).run();
}

// ---------------------------------------------------------------- milestones

export function listMilestones(userId: string): Milestone[] {
  return getDb()
    .select({
      id: schema.homeMilestones.id,
      title: schema.homeMilestones.title,
      date: schema.homeMilestones.date,
      yearly: schema.homeMilestones.yearly,
      leadDays: schema.homeMilestones.leadDays,
    })
    .from(schema.homeMilestones)
    .where(eq(schema.homeMilestones.userId, userId))
    .orderBy(schema.homeMilestones.date)
    .all();
}

export function addMilestone(userId: string, m: Omit<Milestone, "id">) {
  if (listMilestones(userId).length >= MAX_MILESTONES) throw new HttpError(409, "too_many", `Up to ${MAX_MILESTONES} saved dates`);
  const id = newId("hms");
  getDb()
    .insert(schema.homeMilestones)
    .values({ id, userId, ...m })
    .run();
  return id;
}

export function deleteMilestone(userId: string, id: string) {
  return (
    getDb()
      .delete(schema.homeMilestones)
      .where(and(eq(schema.homeMilestones.userId, userId), eq(schema.homeMilestones.id, id)))
      .run().changes > 0
  );
}

// ---------------------------------------------------------------- listing

export type TuningView = {
  categories: { category: string; label: string; weight: number }[];
  snoozed: { id: string; label: string; until: string }[];
  feedback: {
    id: string;
    targetKind: string;
    targetId: string;
    category: string;
    label: string;
    verdict: FeedbackVerdict;
    verdictLabel: string;
    correction?: string;
    why: string[];
    createdAt: string;
  }[];
  milestones: Milestone[];
};

/** Everything a person has told Home, for Settings → Home priorities. `titles` resolves action ids to what's on screen. */
export function tuningView(user: Viewer, titles: Map<string, string>, now = new Date()): TuningView {
  const db = getDb();
  const categories = db
    .select()
    .from(schema.homeCategoryPrefs)
    .where(eq(schema.homeCategoryPrefs.userId, user.id))
    .all()
    .map((r) => ({ category: r.category, label: categoryLabel(r.category), weight: r.weight }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const snoozed = db
    .select()
    .from(schema.actionPrefs)
    .where(
      and(
        eq(schema.actionPrefs.userId, user.id),
        or(gt(schema.actionPrefs.hiddenUntil, now.toISOString()), gt(schema.actionPrefs.acknowledgedUntil, now.toISOString())),
      ),
    )
    .all()
    .map((p) => ({
      id: p.actionId,
      label: titles.get(p.actionId) ?? describeTarget(p.actionId),
      until: [p.hiddenUntil, p.acknowledgedUntil]
        .filter((v): v is string => !!v)
        .sort()
        .at(-1)!,
    }))
    .sort((a, b) => (a.until < b.until ? -1 : 1));
  const feedback = db
    .select()
    .from(schema.homeFeedback)
    .where(eq(schema.homeFeedback.userId, user.id))
    .orderBy(desc(schema.homeFeedback.createdAt))
    .limit(50)
    .all()
    .map((r) => {
      let why: string[] = [];
      try {
        why = (JSON.parse(r.provenance) as { why?: string[] }).why ?? [];
      } catch {
        /* keep empty */
      }
      return {
        id: r.id,
        targetKind: r.targetKind,
        targetId: r.targetId,
        category: r.category,
        label: titles.get(r.targetId) ?? describeTarget(r.targetId),
        verdict: r.verdict as FeedbackVerdict,
        verdictLabel: VERDICT_LABELS[r.verdict as FeedbackVerdict] ?? r.verdict,
        correction: r.correction ?? undefined,
        why,
        createdAt: r.createdAt,
      };
    });
  return { categories, snoozed, feedback, milestones: listMilestones(user.id) };
}

function describeTarget(id: string) {
  if (id === "assist:overdue_triage") return "Overdue triage suggestion";
  if (id.startsWith("assist:plan:")) return "Plan-ahead suggestion";
  if (id.startsWith("assist:seasonal:")) return "Seasonal suggestion";
  const source = id.slice(0, id.indexOf(":"));
  return `${categoryLabel(`source:${source}`)} item`;
}

/**
 * A bounded, plain summary of this person's tuning for "Tune with Hermes".
 * Hermes may suggest changes; the person applies them in Settings.
 */
export function hermesBrief(view: TuningView, budget: { now: number; today: number; upcoming: number }) {
  const lines = [
    `Jarvis Home ranking (version 1): Now shows up to ${budget.now}, Today up to ${budget.today}, Upcoming preview ${budget.upcoming}; the rest is a counted backlog.`,
    "Tiers: safety alerts, waiting on me, pinned, Daily Compass focus, recently overdue, due within 4h, check-in window, due today, long overdue, next 14 days, someday.",
    "Category weights (−2 = kept out of Now/Today, −1 lower, +1 higher):",
    ...(view.categories.length ? view.categories.map((c) => `- ${c.label}: ${c.weight > 0 ? "+" : ""}${c.weight}`) : ["- none (all normal)"]),
    `Snoozed: ${view.snoozed.length}. Saved dates: ${view.milestones.length}.`,
  ];
  const corrections = view.feedback.filter((f) => f.correction).slice(0, 10);
  if (corrections.length) {
    lines.push("My recent corrections:");
    for (const f of corrections) lines.push(`- ${f.verdictLabel} on “${f.label.slice(0, 80)}”: ${f.correction!.slice(0, 200)}`);
  }
  const text = lines.join("\n");
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

/** Can this person reschedule todos (for the triage dialog)? */
export function canReschedule(user: Capable) {
  return can(user, "todos.edit");
}
