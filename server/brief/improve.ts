import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { newId } from "@/server/crypto";
import { HttpError } from "@/server/http/errors";
import { getPreferences } from "@/server/settings";
import { isConfigured } from "@/integrations/store";
import { sessionProfile } from "@/integrations/hermes/service";
import { createSession, startRun, stopRun } from "@/server/assistant";
import { requestedAgentFor, resolveAgentForNode } from "@/server/agents/routing";
import { areaPolicyFor } from "@/server/ai/jobs";
import { credentialsMessage, maskSecrets } from "@/server/ai/rules";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { areaDefaultsFor } from "@/server/references";
import { agentRuns } from "@/server/work/agent-runs";
import { filedChatContext } from "@/server/work/chat-context";
import { globalCoordinatorArea } from "@/server/work/coordinator";
import { conversationNodes, createItem, ensureMiscellaneous, listItems, placeConversation, updateItem } from "@/server/work/store";
import { isClosed, type WorkItem } from "@/lib/work";
import { addDays, localDate } from "@/lib/time";
import { BRIEF_LIMITS, type BriefImproveInput, type BriefImproveView, type BriefImprovementView } from "@/lib/brief";
import { getBriefSettings, saveBriefSettings } from "./store";

/**
 * "Improve" on the brief: the person says what should change and an agent takes
 * it from there. Jarvis files it as an item under an area, opens a Hermes
 * conversation with that area's agent under the item, and sends the request as
 * the first message, exactly as if the person had typed it in that chat. The
 * agent works with the tools and limits it already has; nothing here gives it more.
 *
 * Only the person's own words leave (plus where the item is filed): no brief
 * content, no check-ins, no notes.
 */

const I = schema.briefImprovements;
export type ImprovementRow = typeof I.$inferSelect;
type Row = ImprovementRow;

export const IMPROVE_CAPS = ["brief.use", "hermes.chat", "work.use"] as const;
export const improveDeps = { createSession, startRun, stopRun };
export type ImproveDeps = typeof improveDeps;

export const canImprove = (user: CurrentUser) => IMPROVE_CAPS.every((c) => can(user, c));

/** Top-level areas that may take AI work. */
export function eligibleAreas(items: WorkItem[]) {
  return items.filter((i) => i.kind === "area" && i.parentId === null && !i.archived && i.settings?.aiPolicy !== "excluded");
}

/**
 * Where a request goes unless the person says otherwise: the area they picked
 * last time, else the existing area called "Jarvis", else the portfolio coordinator's
 * area. Null means Miscellaneous (Hermes' default profile).
 */
export function improveArea(user: CurrentUser, items: WorkItem[] = listItems(user.id)): WorkItem | null {
  const areas = eligibleAreas(items);
  const saved = getBriefSettings(user.id).improveAreaId;
  const named = areas.find((a) => a.id === saved) ?? areas.find((a) => a.title.trim().toLowerCase() === "jarvis");
  if (named) return named;
  const chief = globalCoordinatorArea(user)?.id;
  return areas.find((a) => a.id === chief) ?? null;
}

/** The first line of the request, cut at a word, as the item's title. */
export function improveTitle(text: string) {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const first = line.split(/(?<=[.!?])\s/)[0] ?? line;
  const clean = first.replace(/[.!?]+$/, "").trim();
  if (clean.length <= 80) return clean;
  const cut = clean.slice(0, 80);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trim()}…`;
}

function improvementView(row: Row, item: WorkItem, live: Pick<BriefImprovementView, "live" | "approval">): BriefImprovementView {
  return {
    id: row.id,
    kind: row.kind === "assist" ? "assist" : "improve",
    title: item.title,
    ...live,
    itemId: row.itemId,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
  };
}

/** `created_at` is SQLite's UTC "YYYY-MM-DD HH:MM:SS". */
const createdDay = (row: Row) => row.createdAt.slice(0, 10);

/**
 * Whether a request still belongs on the page. A change to the app stays until its item is closed.
 * A row that was looked into stays for a few days (its item may be an initiative that runs for
 * months), and goes at once when its conversation is archived.
 */
export function stillOpen(row: Row, byId: Map<string, WorkItem>, chats: Map<string, { archived: boolean }>, today = localDate(new Date(), "UTC")) {
  const item = byId.get(row.itemId);
  if (!item || item.archived) return false;
  if (row.kind !== "assist") return !isClosed(item.status);
  const chat = chats.get(row.sessionId);
  if (!chat || chat.archived) return false;
  if (row.ownsItem && isClosed(item.status)) return false;
  return createdDay(row) >= addDays(today, -BRIEF_LIMITS.assistDays);
}

/** This person's recent requests, newest first. */
export function recentRows(userId: string): Row[] {
  return getDb().select().from(I).where(eq(I.userId, userId)).orderBy(desc(I.createdAt)).limit(40).all();
}

/** Requests whose item is still open, newest first. Reads Jarvis' own records only. */
export function openImprovements(user: CurrentUser, items: WorkItem[] = listItems(user.id)): BriefImprovementView[] {
  const rows = recentRows(user.id);
  if (!rows.length) return [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const chats = conversationNodes(user.id);
  const open = rows.filter((r) => stillOpen(r, byId, chats));
  if (!open.length) return [];
  const info = agentRuns(user, items).items;
  return open.slice(0, BRIEF_LIMITS.improveOpen).map((r) => {
    const a = info[r.itemId];
    return improvementView(r, byId.get(r.itemId)!, { live: a?.live ?? "idle", ...(a?.approval ? { approval: true } : {}) });
  });
}

export function improveView(user: CurrentUser): BriefImproveView {
  if (!canImprove(user) || !isConfigured("hermes")) return { available: false, areaId: null, areas: [], open: [] };
  const items = listItems(user.id);
  return {
    available: true,
    areaId: improveArea(user, items)?.id ?? null,
    areas: eligibleAreas(items).map((a) => ({ id: a.id, title: a.title, agent: resolveAgentForNode(user.id, a.id).profile })),
    open: openImprovements(user, items),
  };
}

export function ownRow(user: CurrentUser, id: string): Row {
  const row = getDb()
    .select()
    .from(I)
    .where(and(eq(I.userId, user.id), eq(I.id, id)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That request isn't here");
  return row;
}

/** A retry with the same browser key finds the request it already made. */
export function priorRow(user: CurrentUser, clientKey: string): Row | undefined {
  return getDb()
    .select()
    .from(I)
    .where(and(eq(I.userId, user.id), eq(I.clientKey, clientKey)))
    .get();
}

/** What a start returns: the request as the page shows it, and the refreshed "In the works". */
export function resultFor(user: CurrentUser, row: Row): { improvement: BriefImprovementView; improve: BriefImproveView } {
  const improve = improveView(user);
  const item = listItems(user.id, { includeArchived: true }).find((i) => i.id === row.itemId);
  const improvement = improve.open.find((o) => o.id === row.id) ?? improvementView(row, item!, { live: "idle" });
  return { improvement, improve };
}

/** What the agent is sent: the person's words, and the item that tracks them. */
export function improvePrompt(text: string, item: Pick<WorkItem, "id" | "title">) {
  return [
    "I want to change how Atlas works for me. I am asking from my daily brief (the Home screen).",
    `What I want:\n${text}`,
    `This is tracked as the Atlas item "${item.title}" (id ${item.id}). Work out what it takes, ask me whenever a decision is mine to make, and keep that item up to date as you go. This is a request to change the app, not to rewrite today's brief.`,
  ].join("\n\n");
}

/** Take a request back out of the tree: its conversation, and its item when Jarvis made that item for it. */
function putBack(user: CurrentUser, itemId: string | null, sessionId: string | null, correlationId: string) {
  try {
    const node = sessionId ? conversationNodes(user.id).get(sessionId) : null;
    if (node && !node.archived) updateItem(user, node.id, { archived: true }, correlationId);
    if (itemId) updateItem(user, itemId, { archived: true }, correlationId);
  } catch {
    // Best effort: an item left behind is visible in Areas and can be archived there.
  }
}

export type Launch = {
  clientKey: string;
  /** the item the conversation is filed under */
  item: WorkItem;
  /** Jarvis made `item` for this request (Undo and a failed start archive it again) */
  ownsItem: boolean;
  /** the conversation's title */
  title: string;
  /** the first message */
  input: string;
  kind: "improve" | "assist";
  targetKey?: string;
  intent?: string;
};

/**
 * Open a Hermes conversation under an item, on the profile routed for it, and send the first
 * message with the instructions a message typed in that chat would carry (the runs route). If the
 * conversation or the run cannot be started nothing is left behind.
 */
export async function launch(user: CurrentUser, l: Launch, correlationId: string, deps: ImproveDeps = improveDeps): Promise<Row> {
  const db = getDb();
  const id = newId("bim");
  let sessionId: string | null = null;
  try {
    const profile = resolveAgentForNode(user.id, l.item.id).profile;
    const session = await deps.createSession(user, l.title, "hermes", profile);
    sessionId = session.id;
    placeConversation(user, { sessionId, parentId: l.item.id, title: l.title }, correlationId);
    db.insert(I)
      .values({
        id,
        userId: user.id,
        clientKey: l.clientKey,
        itemId: l.item.id,
        sessionId,
        kind: l.kind,
        targetKey: l.targetKey ?? null,
        intent: l.intent ?? null,
        ownsItem: l.ownsItem,
      })
      .run();

    const where = areaDefaultsFor(user, sessionId);
    const s = where?.settings;
    const onProfile = sessionProfile(sessionId);
    const mode = where ? requestedAgentFor(user.id, where.nodeId).agentMode : null;
    const modeHint = mode && mode.trim().toLowerCase() !== onProfile ? mode : null;
    const areaInstructions =
      where && s && (modeHint || s.instructions)
        ? [`Atlas area: ${where.area.title}.`, modeHint ? `Agent mode: ${modeHint}.` : "", s.instructions ?? ""].filter(Boolean).join(" ")
        : undefined;
    // Where it is filed and whether the agent has Jarvis tools, and no more: not the open items under it. A
    // sparkle on an initiative sends that one task, never its child tasks and notes; Improve sends only the words.
    const filed = filedChatContext(user, sessionId, onProfile, { snapshot: false });
    const instructions = maskAccountNumbers(maskSecrets([areaInstructions, filed].filter(Boolean).join("\n\n")).text);
    const prefs = getPreferences().hermes;
    const run = await deps.startRun(
      user,
      {
        sessionId,
        input: l.input,
        idempotencyKey: `${l.kind}-${id}`,
        model: s?.defaultModel || prefs.defaultModel || undefined,
        provider: s?.defaultProvider || prefs.defaultProvider || undefined,
        ...(prefs.defaultReasoning && !s?.defaultModel ? { modelOptions: { reasoning: { effort: prefs.defaultReasoning } } } : {}),
        ...(instructions ? { instructions } : {}),
      },
      correlationId,
    );
    db.update(I).set({ runId: run.runId }).where(eq(I.id, id)).run();
  } catch (e) {
    db.delete(I).where(eq(I.id, id)).run();
    putBack(user, l.ownsItem ? l.item.id : null, sessionId, correlationId);
    throw e;
  }
  return ownRow(user, id);
}

/** Start an agent on a change the person asked for. A retry with the same `clientKey` returns the same request. */
export async function startImprovement(
  user: CurrentUser,
  body: BriefImproveInput,
  correlationId: string,
  deps: ImproveDeps = improveDeps,
): Promise<{ improvement: BriefImprovementView; improve: BriefImproveView }> {
  if (!isConfigured("hermes")) throw new HttpError(409, "backend_unavailable", "Hermes isn't connected.");
  const prior = priorRow(user, body.clientKey);
  if (prior) return resultFor(user, prior);

  // A credential never becomes an item title or reaches the agent.
  const typed = maskSecrets(body.text);
  if (typed.masked.length) throw new HttpError(403, "credentials_detected", credentialsMessage(typed.masked, "request"));
  const text = maskAccountNumbers(body.text.trim());

  const items = listItems(user.id);
  let area: WorkItem | null;
  if (body.areaId === undefined) area = improveArea(user, items);
  else if (body.areaId === null) area = null;
  else {
    area = eligibleAreas(items).find((a) => a.id === body.areaId) ?? null;
    if (!area) throw new HttpError(409, "area_unavailable", "That area can't take AI work");
  }
  const parentId = area?.id ?? ensureMiscellaneous(user.id).id;
  if (areaPolicyFor(user.id, parentId) === "excluded") throw new HttpError(409, "ai_excluded_area", "AI is off in this area");
  // The person's choice of area is remembered for next time.
  if (body.areaId !== undefined) saveBriefSettings(user.id, { improveAreaId: body.areaId });

  const title = improveTitle(text);
  const item = createItem(user, { kind: "thread", parentId, title, summary: text }, correlationId);
  const row = await launch(
    user,
    { clientKey: body.clientKey, item, ownsItem: true, title, input: improvePrompt(text, item), kind: "improve" },
    correlationId,
    deps,
  );
  const id = row.id;
  const sessionId = row.sessionId;
  audit({
    actor: user.id,
    action: "brief.improve",
    source: "brief",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { itemId: item.id, session: sessionId, area: area?.id ?? null },
  });
  return resultFor(user, row);
}

/**
 * Undo: stop the agent if it is still going and archive the item and its
 * conversation. Whatever the agent already did elsewhere is not reversed here.
 */
export async function cancelImprovement(user: CurrentUser, id: string, correlationId: string, deps: ImproveDeps = improveDeps) {
  const row = ownRow(user, id);
  let stopped = false;
  if (row.runId) {
    try {
      await deps.stopRun(user, row.runId, correlationId);
      stopped = true;
    } catch {
      // Already finished, or Hermes isn't answering: the item is still taken back.
    }
  }
  putBack(user, row.ownsItem ? row.itemId : null, row.sessionId, correlationId);
  getDb().delete(I).where(eq(I.id, row.id)).run();
  audit({ actor: user.id, action: "brief.improve_cancel", source: "brief", sourceRecord: id, result: "ok", correlationId, detail: { stopped } });
  return { ok: true, stopped, improve: improveView(user) };
}
