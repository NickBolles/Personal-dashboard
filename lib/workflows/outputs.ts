/**
 * Workflows W4 — pure output helpers (no IO): Markdown export, action
 * promotion plan, session history/stats, Edit-session ops (#132) and the
 * Sunday reminder schedule. Shared by server routes and client components.
 *
 * Rules: nothing here writes anywhere; exports are rendered from the run's
 * own capture; stats are plain counts (no streaks, goals or scores).
 */
import { formFields, type WorkflowDefinition } from "./definition";
import { displayValue, normaliseFieldValue, type Capture, type CaptureOp } from "./runs";
import { parseScriptureRef } from "./scripture";

/* ---------------- Markdown export (always available, local) ---------------- */

export type RunForExport = { title: string; startedAt: string; endedAt?: string | null; capture: Capture; summary?: string | null };

const mdEscape = (s: string) => s.replace(/\r/g, "").trim();
const title = (k: string) => k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, " $1");

/** Render a run as Markdown: title, session facts, accepted summary, then each capture list. */
export function runMarkdown(def: WorkflowDefinition, run: RunForExport): string {
  const out: string[] = [`# ${mdEscape(run.title || def.name)}`, ""];
  for (const [key, entry] of Object.entries(def.capture)) {
    if (entry.type !== "object") continue;
    const obj = (run.capture[key] ?? {}) as Record<string, unknown>;
    const facts = Object.keys(entry.fields)
      .map((f) => [f, displayValue(obj[f])] as const)
      .filter(([, v]) => v);
    for (const [f, v] of facts) out.push(`- **${title(f)}:** ${mdEscape(v)}`);
    if (facts.length) out.push("");
  }
  if (run.summary?.trim()) out.push("## Summary", "", mdEscape(run.summary), "");
  for (const [key, entry] of Object.entries(def.capture)) {
    if (entry.type !== "list") continue;
    const rows = Array.isArray(run.capture[key]) ? (run.capture[key] as unknown[]) : [];
    if (!rows.length) continue;
    out.push(`## ${title(key)}`, "");
    for (const r of rows) {
      if (key === "quotes" && r && typeof r === "object") {
        const q = r as { text?: unknown; who?: unknown };
        out.push(`> ${mdEscape(displayValue(q.text))}${q.who ? ` — ${mdEscape(displayValue(q.who))}` : ""}`, "");
        continue;
      }
      const o = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
      const main = mdEscape(displayValue(r));
      const extras = o
        ? Object.entries(o)
            .slice(1)
            .filter(([k, v]) => k !== "promote" && displayValue(v))
            .map(([, v]) => mdEscape(displayValue(v)))
        : [];
      out.push(`- ${main}${extras.length ? ` — ${extras.join("; ")}` : ""}`);
    }
    out.push("");
  }
  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

/** File name for the download: `teaching-2026-11-01.md`. */
export function markdownFileName(def: WorkflowDefinition, startedAt: string): string {
  return `${def.slug}-${startedAt.slice(0, 10)}.md`;
}

/** The Drive export target, if the definition declares one (`Teaching notes/{yyyy}`). */
export function driveFolder(def: WorkflowDefinition, startedAt: string): string | null {
  const e = def.outputs?.exports?.find((x) => x.kind === "drive");
  return e && e.kind === "drive" ? e.folder.replace(/\{yyyy\}/g, startedAt.slice(0, 4)) : null;
}

/* ---------------- Action checklist → "Create N items?" ---------------- */

export const MAX_PROMOTE = 20;
export type PromotePlan = { index: number; title: string; parent: string; due: string | null };

/** Which list holds actions and where promoted items go (definition `items` export, else none). */
export function actionsExport(def: WorkflowDefinition): { from: string; parent: string } | null {
  const e = def.outputs?.exports?.find((x) => x.kind === "items");
  if (e && e.kind === "items") return { from: e.from, parent: e.parent };
  return def.capture.actions?.type === "list" ? { from: "actions", parent: "" } : null;
}

/** Exact titles/destination/due shown in the confirm sheet. Dedupes and caps at MAX_PROMOTE. */
export function promotePlan(def: WorkflowDefinition, capture: Capture, indices: number[], opts: { parent: string; due: string | null }): PromotePlan[] {
  const ex = actionsExport(def);
  if (!ex) return [];
  const rows = Array.isArray(capture[ex.from]) ? (capture[ex.from] as unknown[]) : [];
  const seen = new Set<number>();
  const plan: PromotePlan[] = [];
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= rows.length || seen.has(i)) continue;
    seen.add(i);
    const t = displayValue(rows[i]).trim().slice(0, 200);
    if (!t) continue;
    plan.push({ index: i, title: t, parent: opts.parent, due: opts.due });
    if (plan.length >= MAX_PROMOTE) break;
  }
  return plan;
}

/* ---------------- Session history + stats ---------------- */

export type HistoryRun = { id: string; title: string; status: string; startedAt: string; conversationId: string | null; capture: Capture };
export type HistoryRow = {
  id: string;
  title: string;
  status: string;
  date: string;
  place: string;
  speaker: string;
  series: string;
  scripture: string;
  books: string[];
  counts: Record<string, number>;
  conversationId: string | null;
};

function sessionObj(capture: Capture): Record<string, unknown> {
  const s = capture.session;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

function refBook(v: unknown): string | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const ref = o && "ref" in o ? o.ref : v;
  if (ref && typeof ref === "object" && typeof (ref as { book?: unknown }).book === "string") return (ref as { book: string }).book;
  const p = parseScriptureRef(displayValue(ref));
  return p.ok ? p.ref.book : null;
}

export function historyRow(def: WorkflowDefinition, run: HistoryRun): HistoryRow {
  const s = sessionObj(run.capture);
  const scripture = Array.isArray(run.capture.scripture) ? (run.capture.scripture as unknown[]) : [];
  const counts: Record<string, number> = {};
  for (const [k, e] of Object.entries(def.capture)) if (e.type === "list") counts[k] = Array.isArray(run.capture[k]) ? (run.capture[k] as unknown[]).length : 0;
  const when = displayValue(s.when ?? s.date);
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    date: (when || run.startedAt).slice(0, 10),
    place: displayValue(s.place),
    speaker: displayValue(s.speaker),
    series: displayValue(s.series),
    scripture: scripture.length ? displayValue(scripture[0]) : "",
    books: [...new Set(scripture.map(refBook).filter((b): b is string => !!b))],
    counts,
    conversationId: run.conversationId,
  };
}

export type HistoryFilter = { speaker?: string; place?: string; series?: string; book?: string };

export function filterHistory(rows: HistoryRow[], f: HistoryFilter): HistoryRow[] {
  return rows.filter(
    (r) =>
      (!f.speaker || r.speaker === f.speaker) &&
      (!f.place || r.place === f.place) &&
      (!f.series || r.series === f.series) &&
      (!f.book || r.books.includes(f.book)),
  );
}

/** Distinct filter values (by frequency, then name). */
export function filterOptions(rows: HistoryRow[]) {
  const top = (vals: string[]) => topCounts(vals, 20).map((x) => x.label);
  return {
    speaker: top(rows.map((r) => r.speaker)),
    place: top(rows.map((r) => r.place)),
    series: top(rows.map((r) => r.series)),
    book: top(rows.flatMap((r) => r.books)),
  };
}

export function topCounts(values: string[], limit = 5): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Plain counts: sessions per month (last `months`, oldest first, zero-filled), top books, top speakers. */
export function runStats(rows: HistoryRow[], today: string, months = 12) {
  const [y, m] = today.split("-").map(Number);
  const perMonth: { month: string; count: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    perMonth.push({ month: key, count: rows.filter((r) => r.date.startsWith(key)).length });
  }
  return {
    total: rows.length,
    perMonth,
    topBooks: topCounts(rows.flatMap((r) => r.books)),
    topSpeakers: topCounts(rows.map((r) => r.speaker)),
  };
}

/* ---------------- Edit session (#132) ---------------- */

/** Mid-form fields that Edit session may change: scalar binds only (list items are edited individually in the outline). */
export function editableMidFields(def: WorkflowDefinition) {
  return formFields(def, "mid").filter((f) => !f.bind.endsWith("/-"));
}

/** REPLACE ops for changed scalar fields only; unchanged values and list binds produce nothing. */
export function editSessionOps(def: WorkflowDefinition, capture: Capture, values: Record<string, unknown>): CaptureOp[] {
  const ops: CaptureOp[] = [];
  for (const f of editableMidFields(def)) {
    if (!(f.id in values)) continue;
    const [a, b] = f.bind.split(".");
    const next = normaliseFieldValue(f, values[f.id]);
    const cur = b ? ((capture[a] ?? {}) as Record<string, unknown>)[b] : capture[a];
    if (JSON.stringify(next ?? null) === JSON.stringify(cur ?? null)) continue;
    ops.push({ op: "replace", path: b ? `/${a}/${b}` : `/${a}`, value: next ?? null });
  }
  return ops;
}

/* ---------------- Sunday reminder (D6: remind only) ---------------- */

export type ReminderSchedule = { enabled: boolean; day: number /* 0 = Sunday */; time: string /* HH:MM */ };
export const DEFAULT_REMINDER: ReminderSchedule = { enabled: false, day: 0, time: "09:45" };

/** The schedule declared by the definition's `schedule` trigger (cron `M H * * D`), remind-only. */
export function reminderFromDefinition(def: WorkflowDefinition): ReminderSchedule | null {
  const t = def.triggers?.find((x) => x.kind === "schedule");
  if (!t || t.kind !== "schedule") return null;
  const [mi, h, , , d] = t.cron.split(" ");
  const day = Number(d),
    hh = Number(h),
    mm = Number(mi);
  if (![day, hh, mm].every(Number.isInteger) || day < 0 || day > 6 || hh > 23 || mm > 59) return null;
  return { enabled: false, day, time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}

/**
 * Is a reminder due? `local` = owner-timezone wall clock now ({date, weekday, minutes}).
 * Fires once per local date, within 60 min after the slot (late dispatcher ticks still send; never early).
 */
export function reminderDue(s: ReminderSchedule, local: { date: string; weekday: number; minutes: number }, lastSentDate: string | null): boolean {
  if (!s.enabled || local.weekday !== s.day || lastSentDate === local.date) return false;
  const [h, m] = s.time.split(":").map(Number);
  const at = h * 60 + m;
  return local.minutes >= at && local.minutes < at + 60;
}
