import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getDetail } from "@/server/work/store";
import type { ContextSource, WorkDetail } from "@/lib/work";

/**
 * Allowlisted context for an AI job (spec §6.2). Never: conversation
 * transcripts, finance (no finance module is reachable from server/ai/**; a
 * unit test scans the import graph), HA live state unless the person picked
 * that context source, secrets or other people's data. ≤ 8000 chars.
 */
export const CONTEXT_MAX = 8000;
export const TRUNCATED = "\n[…context truncated by Jarvis]";

/** Untrusted text goes in a <data> block; a closing tag inside it is neutralised. */
export function wrap(source: string, text: string) {
  const safe = text.replace(/<\/?data\b[^>]*>/gi, (m) => m.replace("<", "‹"));
  return `<data source="${source.replace(/[^a-z0-9_.:-]/gi, "")}">\n${safe}\n</data>`;
}

export function clampContext(text: string, max = CONTEXT_MAX) {
  return text.length <= max ? text : text.slice(0, max - TRUNCATED.length) + TRUNCATED;
}

export function formatItemContext(d: WorkDetail, reports: { kind: string; summary: string }[], instructions?: string) {
  const it = d.item;
  const lines: string[] = [];
  lines.push(`Item: ${it.title} (${it.kind}, ${it.status})`);
  lines.push(`Path: ${d.breadcrumb.map((b) => b.title).join(" › ") || "(top level)"}`);
  if (d.area?.settings.defaultRepo) lines.push(`Area repo: ${d.area.settings.defaultRepo}`);
  if (it.startDate || it.targetDate) lines.push(`Dates: ${it.startDate ?? "?"} → ${it.targetDate ?? "?"}`);
  const parts: string[] = [lines.join("\n")];
  const untrusted: string[] = [];
  if (it.summary) untrusted.push(`Summary: ${it.summary}`);
  if (it.nextAction) untrusted.push(`Next action: ${it.nextAction}`);
  const p = d.packets.at(-1);
  if (p)
    untrusted.push(
      [
        `Packet v${p.version}: objective: ${p.objective}`,
        p.inScope && `In scope: ${p.inScope}`,
        p.acceptanceCriteria && `Acceptance: ${p.acceptanceCriteria}`,
        p.decisions && `Decisions: ${p.decisions}`,
        p.openQuestions && `Open questions: ${p.openQuestions}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  if (d.links.length)
    untrusted.push(
      "Links:\n" +
        d.links
          .filter((l) => l.kind !== "chat_session")
          .slice(0, 12)
          .map((l) => `- ${l.kind} ${l.role}: ${l.title || l.targetId || ""} ${l.url ?? ""} ${l.externalState ?? ""}`.trim())
          .join("\n"),
    );
  if (d.validations.length)
    untrusted.push(
      "Validations:\n" + d.validations.map((v) => `- ${v.metric} ${v.comparator} ${v.threshold}${v.unit ? ` ${v.unit}` : ""} (${v.status})`).join("\n"),
    );
  if (d.children.length)
    untrusted.push(
      "Children:\n" +
        d.children
          .slice(0, 8)
          .map((c) => `- ${c.title} (${c.status})`)
          .join("\n"),
    );
  if (d.blockedBy.length) untrusted.push("Depends on:\n" + d.blockedBy.map((b) => `- ${b.title} (${b.status})`).join("\n"));
  if (reports.length) untrusted.push("Earlier reports:\n" + reports.map((r) => `- ${r.kind}: ${r.summary.slice(0, 300)}`).join("\n"));
  if (untrusted.length) parts.push(wrap("work_item", untrusted.join("\n\n")));
  if (instructions) parts.push(wrap("nick_focus", `Nick's focus for this run: ${instructions}`));
  return parts.join("\n\n");
}

export type InboxContextEntry = {
  title: string;
  note: string;
  url: string | null;
  channel: string | null;
  createdAt: string;
  attachments: { kind: string; mime: string; width: number | null; height: number | null }[];
};

export function formatInboxContext(e: InboxContextEntry, opts: { imagesAnalysed: boolean; brief?: string }) {
  const body = [
    `Title: ${e.title}`,
    e.note && `Note: ${e.note}`,
    e.url && `URL: ${e.url}`,
    `Captured ${e.createdAt} via ${e.channel ?? "web"}`,
    ...e.attachments.map((a) =>
      a.kind === "image"
        ? `[image attached${a.width ? ` ${a.width}×${a.height}` : ""}: ${opts.imagesAnalysed ? "see input" : "not analysed"}]`
        : `[text file attached]`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return [wrap("capture", body), opts.brief ? wrap("triage_brief", opts.brief) : ""].filter(Boolean).join("\n\n");
}

function recentReports(userId: string, subjectId: string) {
  return getDb()
    .select({ kind: schema.aiReports.kind, summary: schema.aiReports.summary })
    .from(schema.aiReports)
    .where(and(eq(schema.aiReports.userId, userId), eq(schema.aiReports.subjectId, subjectId), isNull(schema.aiReports.archivedAt)))
    .orderBy(desc(schema.aiReports.createdAt))
    .limit(3)
    .all();
}

/**
 * Optional "Ask about…" snapshots (Home, Skylight, Todos…). server/context.ts
 * already drops finance; it's loaded lazily so the static import graph of
 * server/ai/** never reaches the source registry (which knows the finance adapter).
 */
async function extraSources(user: { id: string; capabilities: Set<string>; role: string }, sources: ContextSource[] | undefined) {
  if (!sources?.length) return "";
  try {
    const mod = await import("@/server/context");
    const text = await mod.buildContext(user as Parameters<typeof mod.buildContext>[0], sources, undefined);
    return text ? wrap("jarvis_context", String(text)) : "";
  } catch {
    return "";
  }
}

export async function itemContext(
  user: { id: string; capabilities: Set<string>; role: string },
  itemId: string,
  params: { instructions?: string; contextSources?: ContextSource[] },
) {
  const d = getDetail(user.id, itemId);
  const base = formatItemContext(d, recentReports(user.id, itemId), params.instructions);
  const extra = await extraSources(user, params.contextSources);
  return { detail: d, text: clampContext([base, extra].filter(Boolean).join("\n\n")) };
}

export function inboxContext(userId: string, inboxId: string, opts: { imagesAnalysed: boolean; brief?: string }) {
  const e = getDb()
    .select()
    .from(schema.workInbox)
    .where(and(eq(schema.workInbox.id, inboxId), eq(schema.workInbox.userId, userId)))
    .get();
  if (!e) return null;
  const atts = getDb()
    .select()
    .from(schema.captureAttachments)
    .where(and(eq(schema.captureAttachments.inboxId, inboxId), isNull(schema.captureAttachments.deletedAt)))
    .all();
  return {
    entry: e,
    text: clampContext(
      formatInboxContext(
        {
          title: e.title,
          note: e.note,
          url: e.url,
          channel: e.channel,
          createdAt: e.createdAt,
          attachments: atts.map((a) => ({ kind: a.kind, mime: a.mime, width: a.width, height: a.height })),
        },
        opts,
      ),
    ),
  };
}

/** Destinations for triage: the person's non-excluded areas and projects (≤ 60). */
export function triageDestinations(
  userId: string,
  isExcluded: (row: { id: string; title: string; systemKey: string | null; settings: string | null }) => boolean,
) {
  const rows = getDb()
    .select()
    .from(schema.workItems)
    .where(and(eq(schema.workItems.userId, userId), eq(schema.workItems.archived, false)))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rootOf = (r: (typeof rows)[number]) => {
    let cur = r;
    for (let i = 0; cur.parentId && byId.has(cur.parentId) && i < 50; i++) cur = byId.get(cur.parentId)!;
    return cur;
  };
  const out: { key: string; path: string }[] = [];
  for (const r of rows) {
    if (!(r.parentId === null || r.kind === "project")) continue;
    if (isExcluded(rootOf(r))) continue;
    const path: string[] = [];
    let cur: (typeof rows)[number] | undefined = r;
    for (let i = 0; cur && i < 6; i++) {
      path.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    out.push({ key: r.id, path: path.join(" › ") });
    if (out.length >= 60) break;
  }
  return out;
}
