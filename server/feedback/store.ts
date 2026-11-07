import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { config } from "@/server/config";
import { sessionProfile } from "@/integrations/hermes/service";
import { isLocalSession } from "@/lib/assistant";
import { areaDefaultsFor } from "@/server/references";
import { areaOf } from "@/server/ai/jobs";
import { detectSensitivity } from "@/server/ai/rules";
import { ensureMiscellaneous, event, insertItem, listItems, ownedItem, recordOp, type OpOut } from "@/server/work/store";
import {
  FEEDBACK_REASONS,
  FEEDBACK_STATUSES,
  buildTriagePayload,
  canTransition,
  excerptOf,
  feedbackFilterSchema,
  feedbackPatchSchema,
  messageLink,
  rateInputSchema,
  reasonsText,
  type Feedback,
  type FeedbackFilter,
  type FeedbackList,
  type FeedbackPatch,
  type FeedbackReason,
  type FeedbackStatus,
  type RateInput,
  type TriageEntry,
} from "@/lib/feedback";

export const F = schema.messageFeedback;
export type FeedbackRow = typeof F.$inferSelect;

export function feedbackId(raw: string) {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "bad_id", "Invalid feedback id");
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new HttpError(400, "bad_id", "Invalid feedback id");
  return id;
}

const parseList = <T extends string>(raw: string, allowed: readonly T[]): T[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)) : [];
  } catch {
    return [];
  }
};
const parseStrings = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

function view(r: FeedbackRow, items: Map<string, { title: string; archived: boolean }>): Feedback {
  const item = r.itemId ? items.get(r.itemId) : undefined;
  const area = r.areaId ? items.get(r.areaId) : undefined;
  return {
    id: r.id,
    sessionId: r.sessionId,
    messageId: r.messageId,
    surface: r.surface as Feedback["surface"],
    rating: r.rating as Feedback["rating"],
    reasons: parseList(r.reasonsJson, FEEDBACK_REASONS),
    note: r.note,
    excerpt: r.excerpt,
    profile: r.profile,
    areaId: area && !area.archived ? r.areaId : null,
    areaTitle: area && !area.archived ? area.title : null,
    model: r.model,
    tools: parseStrings(r.toolsJson),
    status: (FEEDBACK_STATUSES as readonly string[]).includes(r.status) ? (r.status as FeedbackStatus) : "new",
    fixRequestedAt: r.fixRequestedAt,
    itemId: item && !item.archived ? r.itemId : null,
    itemTitle: item && !item.archived ? item.title : null,
    triagedAt: r.triagedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function itemIndex(userId: string) {
  return new Map(listItems(userId, { includeArchived: true }).map((i) => [i.id, { title: i.title, archived: i.archived }]));
}

export function feedbackRow(user: CurrentUser, id: string): FeedbackRow {
  const r = getDb()
    .select()
    .from(F)
    .where(and(eq(F.userId, user.id), eq(F.id, id)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "That feedback isn't here");
  return r;
}

export function getFeedback(user: CurrentUser, id: string) {
  return view(feedbackRow(user, id), itemIndex(user.id));
}

/** The conversation's area (nearest top-level ancestor), when the person organises work. */
function areaForSession(user: CurrentUser, sessionId: string) {
  try {
    return areaDefaultsFor(user, sessionId)?.area.id ?? null;
  } catch {
    return null;
  }
}

/** Rate (or re-rate) one assistant message. One rating per (person, conversation, message). */
export function rateMessage(user: CurrentUser, input: RateInput, correlationId: string, now = new Date()): Feedback {
  const body = rateInputSchema.parse(input);
  const at = now.toISOString();
  const profile = isLocalSession(body.sessionId) ? "local" : (sessionProfile(body.sessionId) ?? "default");
  const areaId = areaForSession(user, body.sessionId);
  const reasons = body.rating === "up" ? [] : [...new Set(body.reasons)];
  const values = {
    surface: body.surface,
    rating: body.rating,
    reasonsJson: JSON.stringify(reasons),
    note: body.note,
    excerpt: excerptOf(body.text),
    profile,
    areaId,
    model: body.model ?? null,
    toolsJson: JSON.stringify([...new Set(body.tools)].slice(0, 30)),
    updatedAt: at,
  };
  const db = getDb();
  const existing = db
    .select()
    .from(F)
    .where(and(eq(F.userId, user.id), eq(F.sessionId, body.sessionId), eq(F.messageId, body.messageId)))
    .get();
  let id: string;
  if (existing) {
    id = existing.id;
    // A changed verdict is new feedback again; editing reasons/note keeps the review state.
    const reset = existing.rating !== body.rating ? { status: "new", triagedAt: null, triageRunId: null } : {};
    db.update(F)
      .set({ ...values, ...reset, excerpt: values.excerpt || existing.excerpt, model: values.model ?? existing.model })
      .where(eq(F.id, id))
      .run();
  } else {
    id = newId("fb");
    db.insert(F)
      .values({ id, userId: user.id, sessionId: body.sessionId, messageId: body.messageId, ...values, status: "new", createdAt: at })
      .run();
  }
  audit({
    actor: user.id,
    action: "feedback.rate",
    source: "feedback",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { rating: body.rating, surface: body.surface, reasons: reasons.length },
  });
  return getFeedback(user, id);
}

export function deleteFeedback(user: CurrentUser, id: string, correlationId: string) {
  feedbackRow(user, id);
  getDb()
    .delete(F)
    .where(and(eq(F.userId, user.id), eq(F.id, id)))
    .run();
  audit({ actor: user.id, action: "feedback.delete", source: "feedback", sourceRecord: id, result: "ok", correlationId });
  return { ok: true };
}

/** Status/note/reason edits from the inbox (each undoable by patching back). */
export function patchFeedback(user: CurrentUser, id: string, input: FeedbackPatch, correlationId: string, now = new Date()) {
  const r = feedbackRow(user, id);
  const body = feedbackPatchSchema.parse(input);
  const set: Partial<typeof F.$inferInsert> = { updatedAt: now.toISOString() };
  if (body.status && body.status !== r.status) {
    if (!canTransition(r.status as FeedbackStatus, body.status)) throw new HttpError(409, "status", "That status change isn't allowed");
    set.status = body.status;
    set.triagedAt = body.status === "new" ? null : (r.triagedAt ?? now.toISOString());
    if (body.status === "new") set.triageRunId = null;
  }
  if (body.reasons) set.reasonsJson = JSON.stringify(r.rating === "up" ? [] : [...new Set(body.reasons)]);
  if (body.note !== undefined) set.note = body.note;
  if (body.fixRequested !== undefined) set.fixRequestedAt = body.fixRequested ? (r.fixRequestedAt ?? now.toISOString()) : null;
  getDb().update(F).set(set).where(eq(F.id, id)).run();
  audit({
    actor: user.id,
    action: "feedback.update",
    source: "feedback",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { status: body.status ?? null, fixRequested: body.fixRequested ?? null },
  });
  return getFeedback(user, id);
}

export function listFeedback(user: CurrentUser, filter: FeedbackFilter = {}): FeedbackList {
  const f = feedbackFilterSchema.parse(filter);
  const items = itemIndex(user.id);
  const all = getDb()
    .select()
    .from(F)
    .where(eq(F.userId, user.id))
    .all()
    .map((r) => view(r, items))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const entries = all.filter(
    (e) =>
      (!f.rating || e.rating === f.rating) &&
      (!f.status || e.status === f.status) &&
      (!f.reason || e.reasons.includes(f.reason)) &&
      (!f.profile || e.profile === f.profile) &&
      (!f.areaId || e.areaId === f.areaId) &&
      (!f.sessionId || e.sessionId === f.sessionId),
  );
  const areas = new Map<string, string>();
  for (const e of all) if (e.areaId && e.areaTitle) areas.set(e.areaId, e.areaTitle);
  return {
    entries,
    counts: {
      total: all.length,
      down: all.filter((e) => e.rating === "down").length,
      newDown: all.filter((e) => e.rating === "down" && e.status === "new").length,
    },
    profiles: [...new Set(all.map((e) => e.profile))].sort(),
    areas: [...areas].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export function exportFeedback(user: CurrentUser, now = new Date()) {
  return { version: 1, exportedAt: now.toISOString(), entries: listFeedback(user).entries };
}

/** Where "Create item" files a rating: its area when that area allows AI-free filing, else Miscellaneous. */
function itemParent(user: CurrentUser, r: FeedbackRow) {
  if (!r.areaId) return null;
  const area = listItems(user.id).find((i) => i.id === r.areaId && !i.archived);
  return area ? area.id : null;
}

export function feedbackItemText(
  r: Pick<FeedbackRow, "rating" | "note" | "excerpt" | "sessionId" | "messageId" | "profile" | "surface"> & { reasons: FeedbackReason[] },
) {
  const why = r.reasons.length ? reasonsText(r.reasons) : r.rating === "up" ? "Good" : "Not right";
  const title = `Feedback: ${why}${r.excerpt ? ` · ${r.excerpt.slice(0, 60)}${r.excerpt.length > 60 ? "…" : ""}` : ""}`.slice(0, 200);
  const link = messageLink(config.publicOrigin ?? "", r.sessionId, r.messageId);
  const summary = [
    `${r.rating === "down" ? "Rated bad" : "Rated good"}: ${why}, on a reply from @${r.profile} (${r.surface}).`,
    r.note ? `Note: ${r.note}` : "",
    r.excerpt ? `Reply: "${r.excerpt}"` : "",
    `Message: ${link}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title, summary };
}

/** "Create item" from a rating: a thread under its area (Undo from the bar removes it if untouched). */
export function createItemFromFeedback(user: CurrentUser, id: string, correlationId: string, now = new Date()) {
  const r = feedbackRow(user, id);
  if (r.itemId) {
    const live = listItems(user.id).find((i) => i.id === r.itemId && !i.archived);
    if (live) throw new HttpError(409, "has_item", "This feedback already has an item");
  }
  const { title, summary } = feedbackItemText({ ...r, reasons: parseList(r.reasonsJson, FEEDBACK_REASONS) });
  const out: OpOut = {};
  const parent = itemParent(user, r);
  const itemId = getDb().transaction((tx) => {
    if (parent) ownedItem(user.id, parent, tx);
    const itemId = insertItem(tx, user.id, {
      parentId: parent ?? miscId(user, tx),
      kind: "thread",
      title,
      summary,
      nextAction: "Look at this feedback and decide on a fix",
    });
    event(tx, itemId, user.id, { kind: "created", to: "captured", reason: "From feedback" });
    recordOp(tx, user.id, itemId, "create", {}, out);
    tx.update(F)
      .set({ itemId, status: r.status === "new" ? "triaged" : r.status, triagedAt: r.triagedAt ?? now.toISOString(), updatedAt: now.toISOString() })
      .where(eq(F.id, id))
      .run();
    return itemId;
  });
  audit({ actor: user.id, action: "feedback.create_item", source: "feedback", sourceRecord: id, result: "ok", correlationId, detail: { itemId } });
  return { feedback: getFeedback(user, id), itemId, op: out.op ?? null };
}

const miscId = (user: CurrentUser, tx: Parameters<typeof ownedItem>[2]) => ensureMiscellaneous(user.id, tx).id;

/* ---------------- triage (scheduled job kind "feedback") ---------------- */

/** True when the area allows AI (Exclude-from-AI and Finance areas never reach triage). */
function aiAllowed(userId: string, areaId: string | null) {
  if (!areaId) return true;
  const a = areaOf(userId, areaId);
  return !!a && a.aiPolicy !== "excluded";
}

/** New 👎 not already in flight, oldest first, with excluded/sensitive entries dropped. */
export function triageCandidates(user: CurrentUser) {
  const items = itemIndex(user.id);
  const origin = config.publicOrigin ?? "";
  const rows = getDb()
    .select()
    .from(F)
    .where(and(eq(F.userId, user.id), eq(F.rating, "down"), eq(F.status, "new"), isNull(F.triageRunId)))
    .all()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const entries: TriageEntry[] = [];
  for (const r of rows) {
    if (!aiAllowed(user.id, r.areaId)) continue;
    const v = view(r, items);
    if (detectSensitivity([v.note, v.excerpt].join("\n")) !== "none") continue;
    entries.push({
      id: v.id,
      createdAt: v.createdAt,
      surface: v.surface,
      profile: v.profile,
      areaTitle: v.areaTitle,
      model: v.model,
      reasons: v.reasons,
      note: v.note,
      excerpt: v.excerpt,
      tools: v.tools,
      link: messageLink(origin, v.sessionId, v.messageId),
    });
  }
  return entries;
}

export function hasTriageWork(user: CurrentUser) {
  return triageCandidates(user).length > 0;
}

/** Builds the run's feedback block and marks those entries as in flight for `runId`. */
export function claimTriage(user: CurrentUser, runId: string, since: string | null, max = 30) {
  const entries = triageCandidates(user).slice(0, max);
  if (!entries.length) return "";
  getDb()
    .update(F)
    .set({ triageRunId: runId })
    .where(
      and(
        eq(F.userId, user.id),
        inArray(
          F.id,
          entries.map((e) => e.id),
        ),
      ),
    )
    .run();
  return buildTriagePayload(entries, since);
}

/** The triage run finished: its entries become "triaged". */
export function completeTriage(userId: string, runId: string, now = new Date()) {
  getDb()
    .update(F)
    .set({ status: "triaged", triagedAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(and(eq(F.userId, userId), eq(F.triageRunId, runId), eq(F.status, "new")))
    .run();
}

/** The triage run failed: its entries go back to the queue for the next run. */
export function releaseTriage(userId: string, runId: string) {
  getDb()
    .update(F)
    .set({ triageRunId: null })
    .where(and(eq(F.userId, userId), eq(F.triageRunId, runId), eq(F.status, "new")))
    .run();
}
