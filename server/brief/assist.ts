import "server-only";
import type { NextAction } from "@/lib/contracts";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { isConfigured } from "@/integrations/store";
import { areaPolicyFor } from "@/server/ai/jobs";
import { credentialsMessage, maskSecrets } from "@/server/ai/rules";
import { agentRuns } from "@/server/work/agent-runs";
import { globalCoordinatorArea } from "@/server/work/coordinator";
import { conversationNodes, createItem, ensureMiscellaneous, listItems } from "@/server/work/store";
import type { WorkItem } from "@/lib/work";
import { localDate } from "@/lib/time";
import {
  BRIEF_ASSIST_INTENTS,
  BRIEF_LIMITS,
  assistIntent,
  type BriefAssistInput,
  type BriefAssistIntent,
  type BriefAssistView,
  type BriefImproveView,
  type BriefImprovementView,
} from "@/lib/brief";
import { briefContext, line, type BriefContext } from "./context";
import { getBriefSettings } from "./store";
import { canImprove, eligibleAreas, improveDeps, launch, priorRow, recentRows, resultFor, stillOpen, type ImproveDeps, type ImprovementRow } from "./improve";

/**
 * The sparkle on a row of the brief: "look into this one". Jarvis files the task
 * as an item (or uses the item it already is), opens a Hermes conversation with
 * that area's agent under it, and asks for the research the title calls for
 * (who to call, when, whether it can be booked online) and the next steps.
 *
 * Which rows get the button is a rule on the title (lib/brief.ts assistIntent),
 * never a model's choice, and only rows that may go to the AI layer at all
 * (never Finance, never AI-excluded work, never a source switched off). What is
 * sent is that one task: its title, where it lives and when it is due. Nothing
 * else from the brief goes along. The agent is told to research only.
 *
 * What comes back is read from Jarvis' own records: the run's state, the next
 * action on the item, and a "Next steps" note if the agent left one.
 */

const WORK_KINDS = new Set<WorkItem["kind"]>(["project", "investigation", "thread"]);
const targetKey = (t: BriefAssistInput["target"]) => `${t.kind}:${t.id}`;
const isIntent = (v: string | null): v is BriefAssistIntent => (BRIEF_ASSIST_INTENTS as readonly string[]).includes(v ?? "");

export function assistAvailable(user: CurrentUser) {
  return canImprove(user) && isConfigured("hermes");
}

/** A task that came from somewhere else (Skylight, Google Tasks) is filed with the portfolio coordinator, else under Miscellaneous. */
export function assistArea(user: CurrentUser, items: WorkItem[]): WorkItem | null {
  const chief = globalCoordinatorArea(user)?.id;
  return eligibleAreas(items).find((a) => a.id === chief) ?? null;
}

/** The Jarvis item behind a Home action from Areas, when there is one. */
function itemOfAction(a: NextAction, byId: Map<string, WorkItem>): WorkItem | undefined {
  if (a.source !== "work") return undefined;
  const item = byId.get(a.sourceId.slice(a.sourceId.indexOf(":") + 1));
  return item && !item.archived && item.kind !== "conversation" && item.kind !== "note" ? item : undefined;
}

/** Row stamps are SQLite's UTC "YYYY-MM-DD HH:MM:SS"; item stamps may be ISO. */
const stamp = (s: string) => Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

/** One line per step from a note an agent wrote: bullets, numbers and emphasis marks dropped, bounded. */
export function parseSteps(body: string | undefined): string[] {
  return (body ?? "")
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "")
        .replace(/^\s*\[[ xX]?\]\s*/, "")
        .replace(/[*_`#]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l.length >= 3)
    .slice(0, BRIEF_LIMITS.assistSteps)
    .map((l) => (l.length > BRIEF_LIMITS.assistStep ? `${l.slice(0, BRIEF_LIMITS.assistStep - 1).trimEnd()}…` : l));
}

type Asked = { intent: BriefAssistIntent; request: NonNullable<BriefAssistView["request"]> };
export type AssistIndex = { available: boolean; asked: Map<string, Asked> };

/** What this person asked an agent to look into lately, by row. Reads Jarvis' own records only. */
export function assistIndex(user: CurrentUser, items: WorkItem[] = listItems(user.id), today = localDate(new Date(), "UTC")): AssistIndex {
  const asked = new Map<string, Asked>();
  if (!assistAvailable(user)) return { available: false, asked };
  const byId = new Map(items.map((i) => [i.id, i]));
  const chats = conversationNodes(user.id);
  const rows = recentRows(user.id).filter((r) => r.kind === "assist" && r.targetKey && stillOpen(r, byId, chats, today));
  if (!rows.length) return { available: true, asked };
  const info = agentRuns(user, items).items;
  for (const r of rows) {
    // Newest first: a row asked about twice shows the latest.
    if (asked.has(r.targetKey!)) continue;
    const item = byId.get(r.itemId)!;
    const live = info[r.itemId];
    // A note the agent left since it was asked, called "Next steps".
    const note = items
      .filter(
        (i) =>
          i.parentId === item.id &&
          i.kind === "note" &&
          !i.archived &&
          /^next steps\b/i.test(i.title.trim()) &&
          stamp(i.createdAt) >= stamp(r.createdAt) - 1000,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    // The next action on an item Jarvis made for this is the agent's (or the person's own edit of it).
    const next = r.ownsItem ? line(item.nextAction, BRIEF_LIMITS.assistStep) : "";
    const steps = parseSteps(note?.summary).filter((s) => s.toLowerCase() !== next.toLowerCase());
    asked.set(r.targetKey!, {
      intent: isIntent(r.intent) ? r.intent : "steps",
      request: {
        id: r.id,
        live: live?.live ?? "idle",
        ...(live?.approval ? { approval: true } : {}),
        sessionId: r.sessionId,
        ...(next ? { next } : {}),
        ...(steps.length ? { steps } : {}),
      },
    });
  }
  return { available: true, asked };
}

/** The sparkle for a Home action on a row, if it gets one. */
export function assistForAction(ax: AssistIndex, c: BriefContext, a: NextAction): BriefAssistView | undefined {
  if (!ax.available || !c.sendable(a)) return undefined;
  const target = { kind: "action" as const, id: a.id };
  const was = ax.asked.get(targetKey(target));
  const intent = was?.intent ?? assistIntent(a.title);
  // A title that looks like it holds a credential is never offered (and would be refused).
  if (!intent || maskSecrets(a.title).masked.length) return undefined;
  return { intent, target, ...(was ? { request: was.request } : {}) };
}

/**
 * The sparkle for an initiative: offered while it has no next action (that is the suggestion) and
 * Areas are shared with the model, and kept once asked (what was asked then is read from Jarvis'
 * own records; nothing more is sent).
 */
export function assistForItem(ax: AssistIndex, c: Pick<BriefContext, "share">, user: CurrentUser, item: WorkItem): BriefAssistView | undefined {
  if (!ax.available) return undefined;
  const target = { kind: "item" as const, id: item.id };
  const was = ax.asked.get(targetKey(target));
  if (!was && (!c.share.work || item.nextAction.trim())) return undefined;
  if (areaPolicyFor(user.id, item.id) === "excluded" || maskSecrets(item.title).masked.length) return undefined;
  return { intent: was?.intent ?? "steps", target, ...(was ? { request: was.request } : {}) };
}

const ASK: Record<BriefAssistIntent, string> = {
  book: "Find out who I should call or where to book, when they are open, and whether I can book online.",
  fix: "Find out who can do this, how to reach them and when they are open, and roughly what to expect.",
  call: "Find the right number or contact, when they can be reached, and what I should have ready first.",
  buy: "Find a few good options, what they cost and where to get them.",
  admin: "Find out exactly how to do this: where, what I need to have ready, and any deadline or fee.",
  plan: "Draft a simple plan: what has to happen, in what order, and what to decide first.",
  research: "Look into it and tell me what matters.",
  steps: "Work out what it takes and break it into the next steps.",
};

/** What the agent is sent: the one task, what to find out, and that it is research only. */
export function assistPrompt(intent: BriefAssistIntent, task: { title: string; where?: string; due?: string }, item: Pick<WorkItem, "id" | "title">) {
  const about = [task.where, task.due ? `due ${task.due}` : ""].filter(Boolean).join(", ");
  return [
    "I am asking from my daily brief (the Home screen) for help with one of my tasks.",
    `Task: "${task.title}"${about ? ` (${about})` : ""}`,
    ASK[intent],
    "Keep the answer short, then give me the next steps, first one first: five at most, one line each.",
    "This is research only. Do not book, buy, send, call or change anything, and do not mark the task done. Ask me when a choice is mine to make.",
    `It is tracked as the Jarvis item "${item.title}" (id ${item.id}). If you have Jarvis tools, set that item's next action to the first step and add a note on it titled "Next steps" with one step per line.`,
  ].join("\n\n");
}

/** Start an agent on one row. A retry with the same key, or a second tap on a row that is already being looked into, returns that request. */
export async function startAssist(
  user: CurrentUser,
  body: BriefAssistInput,
  correlationId: string,
  deps: ImproveDeps = improveDeps,
  now = new Date(),
): Promise<{ improvement: BriefImprovementView; improve: BriefImproveView }> {
  if (!isConfigured("hermes")) throw new HttpError(409, "backend_unavailable", "Hermes isn't connected.");
  const prior = priorRow(user, body.clientKey);
  if (prior) return resultFor(user, prior);

  const items = listItems(user.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const key = targetKey(body.target);
  const today = localDate(now, "UTC");
  const chats = conversationNodes(user.id);
  const running = recentRows(user.id).find((r) => r.kind === "assist" && r.targetKey === key && stillOpen(r, byId, chats, today));
  if (running) return resultFor(user, running);

  let title: string;
  let intent: BriefAssistIntent;
  let where: string | undefined;
  let due: string | undefined;
  let existing: WorkItem | undefined;
  if (body.target.kind === "action") {
    // The task is read again here: nothing about it is taken from the browser.
    const c = await briefContext(user, now);
    const a = c.actions.get(body.target.id);
    if (!a) throw new HttpError(404, "not_found", "That isn't open any more");
    if (!c.sendable(a)) throw new HttpError(409, "not_shareable", "This one isn't shared with AI");
    title = a.title;
    intent = assistIntent(a.title) ?? "steps";
    where = line(a.sourceLabel ?? "", 60) || undefined;
    due = a.dueAt ? localDate(new Date(a.dueAt), c.timezone) : undefined;
    existing = itemOfAction(a, byId);
  } else {
    const item = byId.get(body.target.id);
    if (!item || item.archived || !WORK_KINDS.has(item.kind)) throw new HttpError(404, "not_found", "That isn't open any more");
    // The same switch that keeps Areas out of the brief keeps an initiative from being sent here.
    if (!getBriefSettings(user.id).share.work) throw new HttpError(409, "not_shareable", "This one isn't shared with AI");
    title = item.title;
    intent = "steps";
    where = "Areas";
    existing = item;
  }
  // A credential never becomes an item title or reaches the agent.
  const typed = maskSecrets(title);
  if (typed.masked.length) throw new HttpError(403, "credentials_detected", credentialsMessage(typed.masked, "task"));
  const clean = line(title, 160);
  if (clean.length < 2) throw new HttpError(409, "nothing_to_ask", "There is nothing to look into here");

  let item: WorkItem;
  if (existing) {
    if (areaPolicyFor(user.id, existing.id) === "excluded") throw new HttpError(409, "ai_excluded_area", "AI is off in this area");
    item = existing;
  } else {
    const parentId = assistArea(user, items)?.id ?? ensureMiscellaneous(user.id).id;
    if (areaPolicyFor(user.id, parentId) === "excluded") throw new HttpError(409, "ai_excluded_area", "AI is off in this area");
    item = createItem(user, { kind: "thread", parentId, title: clean, summary: where ? `From ${where}.` : "" }, correlationId);
  }

  const row: ImprovementRow = await launch(
    user,
    {
      clientKey: body.clientKey,
      item,
      ownsItem: !existing,
      title: clean,
      input: assistPrompt(intent, { title: clean, where, due }, item),
      kind: "assist",
      targetKey: key,
      intent,
    },
    correlationId,
    deps,
  );
  audit({
    actor: user.id,
    action: "brief.assist",
    source: "brief",
    sourceRecord: row.id,
    result: "ok",
    correlationId,
    detail: { itemId: item.id, session: row.sessionId, intent, target: body.target.kind },
  });
  return resultFor(user, row);
}
