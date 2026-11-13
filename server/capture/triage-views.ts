import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { decisionRef } from "@/lib/cw-decisions";
import { runRef } from "@/lib/cw-runs";
import {
  triageActionSchema,
  type CaptureTriageState,
  type CaptureTriageView,
  type ResolvedAction,
  type TriageAction,
  type TriageChoice,
} from "@/lib/capture-triage";

/**
 * Capture triage views (read-only; no integration imports, so the inbox and item routes can use
 * them without reaching Skylight code). The applier lives in ./triage.ts.
 */

const C = schema.captureTriage;
export type Row = typeof C.$inferSelect;
const UNDO_MS = 24 * 3_600_000;

export type Plan = { action: TriageAction | null; choices?: TriageChoice[] };

export function readPlan(r: Row): Plan {
  try {
    const raw = JSON.parse(r.planJson || "null") as unknown;
    // The runner stores the bare action; needs-input rows add the choices.
    const obj = raw && typeof raw === "object" && "action" in (raw as object) ? (raw as { action: unknown; choices?: TriageChoice[] }) : { action: raw };
    const parsed = obj.action == null ? null : triageActionSchema.safeParse(obj.action);
    return { action: parsed && parsed.success ? parsed.data : null, choices: Array.isArray(obj.choices) ? obj.choices : undefined };
  } catch {
    return { action: null };
  }
}

export function readChosen(r: Row): ResolvedAction | null {
  try {
    return r.chosenJson ? (JSON.parse(r.chosenJson) as ResolvedAction) : null;
  } catch {
    return null;
  }
}

// --- Views ---

export function writeUndoable(writeId: string | null) {
  if (!writeId) return false;
  const w = getDb().select().from(schema.skylightWrites).where(eq(schema.skylightWrites.id, writeId)).get();
  return !!w && !w.undoneAt && !!w.inverse && Date.now() - Date.parse(w.at) < UNDO_MS;
}

function openFor(r: Row): { href: string | null; label: string | null } {
  const chosen = readChosen(r);
  const type = chosen?.type ?? readPlan(r).action?.type;
  if (type === "skylight_list_add" || type === "skylight_event_create") return { href: "/skylight", label: "Correct in Skylight" };
  if (type === "ha_device") return { href: "/home-control", label: "Open House" };
  return { href: null, label: null };
}

export function toView(r: Row): CaptureTriageView {
  const db = getDb();
  const dec = r.decisionId ? db.select({ seq: schema.decisions.seq }).from(schema.decisions).where(eq(schema.decisions.id, r.decisionId)).get() : undefined;
  const run = r.runId ? db.select({ seq: schema.agentRuns.seq }).from(schema.agentRuns).where(eq(schema.agentRuns.id, r.runId)).get() : undefined;
  const open = openFor(r);
  return {
    id: r.id,
    inboxId: r.inboxId,
    state: (r.state === "applying" ? "planned" : r.state) as CaptureTriageState,
    summary: r.summary,
    itemId: r.itemId,
    decisionRef: dec ? decisionRef(dec.seq) : null,
    runRef: run ? runRef(run.seq) : null,
    undoable: r.state === "done" && writeUndoable(r.skylightWriteId),
    openHref: r.state === "done" || r.state === "suggested" ? open.href : null,
    openLabel: r.state === "done" || r.state === "suggested" ? open.label : null,
    error: r.state === "failed" ? (r.errorCode ?? "failed") : null,
    canApply: canApply(r),
    at: r.updatedAt,
  };
}

/** Views for inbox rows (skipped rows are hidden: the capture just stays as captured). A failed triage JOB shows a Retry chip too. */
export function triageViewsForInbox(userId: string, entries: { id: string; triageState: string; updatedAt: string }[]) {
  const out = new Map<string, CaptureTriageView>();
  if (!entries.length) return out;
  const rows = getDb()
    .select()
    .from(C)
    .where(
      and(
        eq(C.userId, userId),
        inArray(
          C.inboxId,
          entries.map((e) => e.id),
        ),
      ),
    )
    .all();
  for (const r of rows) if (r.state !== "skipped") out.set(r.inboxId, toView(r));
  for (const e of entries)
    if (!out.has(e.id) && e.triageState === "failed")
      out.set(e.id, {
        id: e.id,
        inboxId: e.id,
        state: "failed",
        summary: "Jarvis couldn't triage this capture.",
        itemId: null,
        decisionRef: null,
        runRef: null,
        undoable: false,
        openHref: null,
        openLabel: null,
        error: "triage_failed",
        at: e.updatedAt,
      });
  return out;
}

export function triageForItem(userId: string, itemId: string): CaptureTriageView | null {
  const r = getDb()
    .select()
    .from(C)
    .where(and(eq(C.userId, userId), eq(C.itemId, itemId)))
    .get();
  return r && r.state !== "skipped" ? toView(r) : null;
}

/** Whether a suggestion row has a "Do it" (a low-risk action Jarvis can run once the owner confirms). */
export function canApply(r: Row): boolean {
  if (r.state !== "suggested") return false;
  const a = readPlan(r).action;
  return !!a && (a.type === "skylight_list_add" || a.type === "skylight_event_create" || a.type === "jarvis_task");
}
