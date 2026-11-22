import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import type { Capable } from "@/server/access";
import { HttpError } from "@/server/http/errors";
import { detectSensitivity } from "@/server/ai/rules";
import { agentItems } from "@/server/agent-access/tools";
import { areaIndex } from "@/lib/map-rollup";
import { effectiveAutonomy, type Proposal } from "@/lib/away";
import { isFinanceAreaLike } from "@/lib/finance-area";
import { isTask } from "@/lib/task-list";
import { isClosed, type WorkItem } from "@/lib/work";
import { liveOfRun } from "@/lib/agent-runs";
import {
  DONE_CARD_MS,
  NOT_NOW_MS,
  SUGGESTION_MAX_AGE_MS,
  SUGGESTIONS_PER_CHANNEL,
  type Suggestion,
  type SuggestionAct,
  type SuggestionAction,
} from "@/lib/suggestions";
import { withVia } from "./actor";
import { globalCoordinatorArea } from "./coordinator";
import { createItem, listItems, undoOp, updateItem, type OpOut } from "./store";
import { activeRun, startTask, steerTask, type TaskRunDeps } from "./task-runs";

/**
 * Suggestions (task threads H1-H7, docs/home-priorities.md). Written by a channel's coordinator: from a scheduled
 * "Suggest next steps" run (a `suggest` proposal) or in a chat with `jarvis_suggest`. Each must cite the owner's own
 * tasks as evidence; Finance and channels closed to AI are never read or written for. Jarvis never acts on one:
 * Start (a task) and Send (a steer) are the owner's tap, and Start can be undone.
 */

const S = schema.suggestions;
const T = schema.suggestionTopics;
type Row = typeof S.$inferSelect;
type Viewer = CurrentUser & Capable;
/** `created`: Start made the task, so Undo also takes it away (removed if untouched, else archived: F3). */
type Result = { itemId: string; title: string; href: string; ops: string[]; created?: boolean; at: string };

/** Undo what Start did, newest first. A task it created that has a chat by now can't be removed: it is archived. */
function undoStart(user: CurrentUser, ops: string[], createdId: string | null, correlationId: string) {
  for (const op of ops) {
    try {
      undoOp(user, op, correlationId);
    } catch (e) {
      if (!createdId || op !== ops.at(-1)) throw e;
      updateItem(user, createdId, { archived: true } as never, correlationId);
    }
  }
}

const taskHref = (id: string) => `/areas?item=${encodeURIComponent(id)}&tab=chat`;
const parseJson = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** What a coordinator may suggest: the owner's items it can see, minus Finance (H7). */
function readable(userId: string) {
  const { items, byId } = agentItems(userId);
  const areaOf = areaIndex(items);
  const channelOf = (id: string) => {
    const areaId = areaOf.get(id);
    const area = areaId ? byId.get(areaId) : undefined;
    if (!area || isFinanceAreaLike(area) || effectiveAutonomy(area) === "off") return null;
    return area;
  };
  return { byId, channelOf };
}

/** A task's chat has a turn in flight (it is working), or is paused on the owner. */
const runningIn = (userId: string, item: WorkItem) => {
  const run = item.primarySessionId ? activeRun(userId, item.primarySessionId) : null;
  return run ? liveOfRun(run.status) : null;
};

/** Why a suggestion can no longer stand, or null while its evidence still holds (H6). */
function staleReason(userId: string, r: Row, view: ReturnType<typeof readable>, now: number): string | null {
  if (now - Date.parse(r.createdAt) > SUGGESTION_MAX_AGE_MS) return "old";
  const channel = view.byId.get(r.channelId);
  if (!channel || view.channelOf(r.channelId)?.id !== r.channelId) return "channel";
  for (const id of parseJson<string[]>(r.evidenceJson, [])) {
    const e = view.byId.get(id);
    if (!e || e.archived || view.channelOf(id)?.id !== r.channelId) return "evidence";
  }
  if (r.itemId) {
    const item = view.byId.get(r.itemId);
    if (!item || item.archived || isClosed(item.status) || view.channelOf(item.id)?.id !== r.channelId) return "target";
    const live = runningIn(userId, item);
    if (r.act === "start" && live) return "started";
    if (r.act === "steer" && live !== "running") return "idle";
  }
  return null;
}

function topics(userId: string) {
  const rows = getDb().select().from(T).where(eq(T.userId, userId)).all();
  return new Map(rows.map((t) => [`${t.channelId}:${t.topic}`, t]));
}

function bumpTopic(userId: string, channelId: string, topic: string, change: { weight?: number; blocked?: boolean }) {
  const at = new Date().toISOString();
  const db = getDb();
  const cur = db
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.channelId, channelId), eq(T.topic, topic)))
    .get();
  const weight = (cur?.weight ?? 0) + (change.weight ?? 0);
  const blocked = change.blocked ?? cur?.blocked ?? false;
  db.insert(T)
    .values({ userId, channelId, topic, weight, blocked, updatedAt: at })
    .onConflictDoUpdate({ target: [T.userId, T.channelId, T.topic], set: { weight, blocked, updatedAt: at } })
    .run();
}

export type SuggestInput = Pick<Proposal, "itemId" | "title" | "text" | "why" | "evidence" | "act" | "topic">;
export type WriteResult = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Store one suggestion for a channel. Refused (with a reason the agent sees): no evidence, evidence or target
 * outside the channel, Finance or a channel closed to AI, credentials, a kind the owner turned off, a repeat.
 * At most five stay open per channel: a sixth replaces the weakest (H3).
 */
export function writeSuggestion(user: CurrentUser, channelId: string, profile: string, p: SuggestInput, runId: string | null, now = new Date()): WriteResult {
  const view = readable(user.id);
  const channel = view.byId.get(channelId);
  if (!channel || channel.parentId !== null || view.channelOf(channelId)?.id !== channelId)
    return { ok: false, reason: "suggestions are only written for a channel open to AI" };
  const title = p.title?.trim().slice(0, 200);
  const why = p.why?.trim().slice(0, 300);
  const brief = p.text?.trim().slice(0, 4000);
  if (!title || !why || !brief) return { ok: false, reason: "a suggestion needs a title, a why and the text the agent is told" };
  if ([title, why, brief].some((t) => detectSensitivity(t) === "credentials")) return { ok: false, reason: "no credentials in a suggestion" };
  const evidence = [...new Set(p.evidence ?? [])];
  if (!evidence.length) return { ok: false, reason: "a suggestion needs evidence: the ids of the tasks the reason comes from" };
  for (const id of evidence) {
    const e = view.byId.get(id);
    if (!e || e.archived || view.channelOf(id)?.id !== channelId) return { ok: false, reason: "evidence must be tasks in this channel" };
  }
  const act: SuggestionAct = p.act ?? "start";
  let target: WorkItem | null = null;
  if (p.itemId) {
    target = view.byId.get(p.itemId) ?? null;
    if (!target || !isTask(target) || target.archived || isClosed(target.status) || view.channelOf(target.id)?.id !== channelId)
      return { ok: false, reason: "the task must be an open task in this channel" };
    const live = runningIn(user.id, target);
    if (act === "start" && live) return { ok: false, reason: "that task is already working: suggest a steer instead" };
    if (act === "steer" && live !== "running") return { ok: false, reason: "a steer is only for a task that is working" };
  } else if (act === "steer") return { ok: false, reason: "a steer needs the task it is for" };
  const topic = p.topic ?? "next_step";
  const prefs = topics(user.id);
  if (prefs.get(`${channelId}:${topic}`)?.blocked) return { ok: false, reason: "the owner turned this kind of suggestion off" };

  const db = getDb();
  const open = db
    .select()
    .from(S)
    .where(and(eq(S.userId, user.id), eq(S.channelId, channelId), eq(S.state, "open")))
    .all();
  const same = (r: Row) => r.title.trim().toLowerCase() === title.toLowerCase() || (!!target && r.itemId === target.id && r.act === act);
  if (open.some(same)) return { ok: false, reason: "already suggested" };
  const id = newId("sug");
  const at = now.toISOString();
  db.transaction((tx) => {
    tx.insert(S)
      .values({
        id,
        userId: user.id,
        channelId,
        profile,
        topic,
        act,
        itemId: target?.id ?? null,
        title,
        why,
        brief,
        evidenceJson: JSON.stringify(evidence),
        runId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    // Over five: the weakest goes (the kind the owner lowered first, then the oldest).
    const score = (r: Pick<Row, "topic" | "createdAt">) => [prefs.get(`${channelId}:${r.topic}`)?.weight ?? 0, Date.parse(r.createdAt)] as const;
    const ranked = [...open, { id, topic, createdAt: at }].sort((a, b) => {
      const [wa, ta] = score(a);
      const [wb, tb] = score(b);
      return wa - wb || ta - tb;
    });
    const drop = ranked.slice(0, Math.max(0, ranked.length - SUGGESTIONS_PER_CHANNEL)).map((r) => r.id);
    if (drop.length) tx.update(S).set({ state: "replaced", updatedAt: at }).where(inArray(S.id, drop)).run();
  });
  return { ok: true, id };
}

function whoFor(user: CurrentUser, channel: WorkItem) {
  return globalCoordinatorArea(user)?.id === channel.id ? "Chief of staff" : `${channel.title} coordinator`;
}

function toSuggestion(user: CurrentUser, r: Row, view: ReturnType<typeof readable>, more: number): Suggestion {
  const channel = view.byId.get(r.channelId)!;
  const result = parseJson<Result | null>(r.resultJson, null);
  return {
    id: r.id,
    channelId: r.channelId,
    channelTitle: channel.title,
    who: whoFor(user, channel),
    topic: r.topic,
    act: r.act as SuggestionAct,
    itemId: r.itemId,
    itemTitle: r.itemId ? (view.byId.get(r.itemId)?.title ?? null) : null,
    title: r.title,
    why: r.why,
    brief: r.brief,
    evidence: parseJson<string[]>(r.evidenceJson, []).flatMap((id) => {
      const e = view.byId.get(id);
      return e ? [{ id, title: e.title }] : [];
    }),
    state: r.state === "started" ? "started" : "open",
    createdAt: r.createdAt,
    more,
    ...(result ? { result: { itemId: result.itemId, title: result.title, href: result.href, undoable: result.ops.length > 0, at: result.at } } : {}),
  };
}

/**
 * The suggestions to draw (H3): one per channel, the strongest kind first, then the newest. `scope` is "all" or
 * a channel id. A suggestion started in the last few minutes stays as its done card, with Undo.
 */
export function listSuggestions(user: CurrentUser, scope: string, now = new Date()): Suggestion[] {
  const view = readable(user.id);
  const db = getDb();
  const rows = db
    .select()
    .from(S)
    .where(and(eq(S.userId, user.id), inArray(S.state, ["open", "started"]), ...(scope === "all" ? [] : [eq(S.channelId, scope)])))
    .all();
  const t = now.getTime();
  const stale: string[] = [];
  const prefs = topics(user.id);
  const live: Row[] = [];
  for (const r of rows) {
    if (r.state === "started") {
      if (t - Date.parse(r.updatedAt) < DONE_CARD_MS && view.byId.has(r.channelId)) live.push(r);
      continue;
    }
    if (staleReason(user.id, r, view, t)) stale.push(r.id);
    else live.push(r);
  }
  if (stale.length) db.update(S).set({ state: "stale", updatedAt: now.toISOString() }).where(inArray(S.id, stale)).run();
  const shown = (r: Row) => !prefs.get(`${r.channelId}:${r.topic}`)?.blocked && (!r.hiddenUntil || Date.parse(r.hiddenUntil) <= t);
  const byChannel = new Map<string, Row[]>();
  for (const r of live) if (r.state === "started" || shown(r)) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r]);
  const out: Suggestion[] = [];
  for (const [channelId, list] of byChannel) {
    const done = list.filter((r) => r.state === "started").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const open = list
      .filter((r) => r.state === "open")
      .sort((a, b) => {
        const w = (r: Row) => prefs.get(`${channelId}:${r.topic}`)?.weight ?? 0;
        return w(b) - w(a) || b.createdAt.localeCompare(a.createdAt);
      });
    const top = done ?? open[0];
    if (top) out.push(toSuggestion(user, top, view, open.length - (top.state === "open" ? 1 : 0)));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function ownRow(userId: string, id: string) {
  const r = getDb()
    .select()
    .from(S)
    .where(and(eq(S.id, id), eq(S.userId, userId)))
    .get();
  if (!r) throw new HttpError(404, "not_found", "Suggestion not found");
  return r;
}

/**
 * The owner's answer to a card. Start: create the task when there is none, then start it in its chat with the
 * brief, on the coordinator that suggested it; Undo stops the run and removes a task that Start created. Send:
 * the brief goes to the working task's chat (nothing to undo once sent). Not now hides it a week and lowers its
 * kind; "Don't suggest this" stops the kind in this channel. Each has its own way back.
 */
export async function actOnSuggestion(user: Viewer, id: string, action: SuggestionAction, correlationId: string, deps?: TaskRunDeps, now = new Date()) {
  const r = ownRow(user.id, id);
  const db = getDb();
  const at = now.toISOString();
  const set = (v: Partial<Row>) =>
    db
      .update(S)
      .set({ ...v, updatedAt: at })
      .where(eq(S.id, id))
      .run();
  switch (action) {
    case "not_now":
      set({ hiddenUntil: new Date(now.getTime() + NOT_NOW_MS).toISOString() });
      bumpTopic(user.id, r.channelId, r.topic, { weight: -1 });
      break;
    case "show_again":
      if (r.hiddenUntil) bumpTopic(user.id, r.channelId, r.topic, { weight: 1 });
      set({ hiddenUntil: null });
      break;
    case "stop_topic":
      bumpTopic(user.id, r.channelId, r.topic, { blocked: true });
      break;
    case "allow_topic":
      bumpTopic(user.id, r.channelId, r.topic, { blocked: false });
      break;
    case "start": {
      if (r.state !== "open") throw new HttpError(409, "not_open", "This suggestion was already acted on");
      const view = readable(user.id);
      const why = staleReason(user.id, r, view, now.getTime());
      if (why) {
        set({ state: "stale" });
        throw new HttpError(409, "stale", "This no longer applies");
      }
      const caller = { user, profile: r.profile, tokenId: null };
      if (r.act === "steer") {
        const item = view.byId.get(r.itemId!)!;
        await steerTask(caller, item, { message: r.brief }, correlationId, deps);
        const result: Result = { itemId: item.id, title: item.title, href: taskHref(item.id), ops: [], at };
        set({ state: "started", resultItemId: item.id, resultJson: JSON.stringify(result) });
        break;
      }
      const ops: string[] = [];
      let item = r.itemId ? view.byId.get(r.itemId)! : null;
      if (!item) {
        // Made by the coordinator that suggested it (the owner's tap is the go-ahead), so it can be undone.
        const out: OpOut = {};
        item = withVia(`agent:${r.profile}`, () => createItem(user, { kind: "thread", title: r.title, parentId: r.channelId }, correlationId, out));
        if (out.op) ops.push(out.op.id);
      }
      try {
        const started = await startTask(
          caller,
          listItems(user.id).find((i) => i.id === item.id)!,
          { brief: r.brief, title: r.title },
          correlationId,
          deps,
          now,
        );
        if (started.undoOpId) ops.unshift(started.undoOpId);
      } catch (e) {
        undoStart(user, ops, r.itemId ? null : item.id, correlationId);
        throw e;
      }
      const result: Result = { itemId: item.id, title: item.title, href: taskHref(item.id), ops, created: !r.itemId, at };
      set({ state: "started", resultItemId: item.id, resultJson: JSON.stringify(result) });
      break;
    }
    case "undo": {
      const result = parseJson<Result | null>(r.resultJson, null);
      if (r.state !== "started" || !result?.ops.length) throw new HttpError(409, "not_undoable", "Nothing to undo");
      undoStart(user, result.ops, result.created ? result.itemId : null, correlationId);
      set({ state: "open", resultItemId: null, resultJson: null });
      break;
    }
  }
  audit({
    actor: user.id,
    action: `work.suggestion_${action}`,
    source: "work",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { act: r.act, topic: r.topic },
  });
  const view = readable(user.id);
  const fresh = ownRow(user.id, id);
  return { suggestion: view.byId.has(fresh.channelId) ? toSuggestion(user, fresh, view, 0) : null };
}

/** What a suggest run is told about its channel's suggestions: open ones (not to repeat) and kinds turned off. */
export function suggestContext(user: CurrentUser, channelId: string, now = new Date()) {
  listSuggestions(user, channelId, now); // marks the stale ones first
  const open = getDb()
    .select()
    .from(S)
    .where(and(eq(S.userId, user.id), eq(S.channelId, channelId), eq(S.state, "open")))
    .all();
  const off = getDb()
    .select()
    .from(T)
    .where(and(eq(T.userId, user.id), eq(T.channelId, channelId), eq(T.blocked, true)))
    .all();
  return [
    open.length ? `Already suggested (do not repeat):\n${open.map((r) => `- ${r.title}`).join("\n")}` : "",
    off.length ? `Kinds the owner turned off here: ${off.map((t) => t.topic).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One suggestion as it stands now (a card in a chat reads it back). */
export function getSuggestion(user: CurrentUser, id: string, now = new Date()): Suggestion | null {
  const r = ownRow(user.id, id);
  const view = readable(user.id);
  if (!view.byId.has(r.channelId)) return null;
  if (r.state === "open" && staleReason(user.id, r, view, now.getTime())) {
    getDb().update(S).set({ state: "stale", updatedAt: now.toISOString() }).where(eq(S.id, id)).run();
    return null;
  }
  if (r.state !== "open" && r.state !== "started") return null;
  return toSuggestion(user, r, view, 0);
}
