import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { HttpError } from "@/server/http/errors";
import * as assistant from "@/server/assistant";
import { liveOfRun } from "@/lib/agent-runs";
import { buildTaskList, isTask, taskMoments, type TaskListResponse, type TaskMoment, type TaskView } from "@/lib/task-list";
import { primarySessionOf } from "@/lib/task-chat";
import { isClosed, type WorkItem } from "@/lib/work";
import { agentRuns } from "./agent-runs";
import { listDecisionRows } from "./decision-store";
import { lastLooked, listRunEvents, recordRunEvent, runTree } from "./run-events";
import { event, listItems, ownedItem, updateItem, type OpOut } from "./store";

/**
 * The task list (lib/task-list.ts): what In flight, a bot's Tasks tab, a project's Tasks section and the review
 * queue all read. From Jarvis's own records only (items, registered runs and their events, open decisions, pull
 * request links): it never calls the assistant, so a list can be polled on a timer.
 */

const agentName = (profile: string) => `@${profile}`;

function source(user: CurrentUser) {
  const items = listItems(user.id);
  const live = new Set(items.map((i) => i.id));
  const { runs } = runTree(user, items);
  return {
    items,
    runs,
    events: listRunEvents(user.id, { runIds: runs.map((r) => r.id), limit: 200 }),
    decisions: listDecisionRows(user.id, { states: ["open"] }).filter((d) => live.has(d.itemId)),
    info: agentRuns(user, items).items,
    lastLooked: lastLooked(user.id).running,
    name: agentName,
  };
}

export function taskList(user: CurrentUser, opts: { scope: string; view: TaskView }, now = Date.now()): TaskListResponse {
  const src = source(user);
  if (opts.scope !== "all" && !src.items.some((i) => i.id === opts.scope)) throw new HttpError(404, "not_found", "No area or project with that id");
  return buildTaskList(src, { ...opts, now });
}

/** One task's own row: its state, reason and what can be done (the task page's header). */
export function taskRowFor(user: CurrentUser, itemId: string, now = Date.now()) {
  const src = source(user);
  const row = buildTaskList(src, { scope: "all", view: "flight", now, focus: itemId }).focus;
  if (!row) throw new HttpError(404, "not_found", "Task not found");
  return row;
}

/** How many of the owner's tasks need them: the navigation badge. */
export const tasksNeedingYou = (user: CurrentUser) => taskList(user, { scope: "all", view: "flight" }).needs;

const DELIVERY_WORD: Record<string, string> = { pending: " · sending", sent: " · sending", delivered: " · delivered", failed: " · not delivered" };

/**
 * A task's timeline, newest first: every report of every run on it and each question it raised, then how it
 * began. The row's activity line opens this in place, and it is the same list the row's peek is cut from.
 */
export function taskTimeline(user: CurrentUser, itemId: string): { moments: TaskMoment[] } {
  const item = ownedItem(user.id, itemId);
  const items = listItems(user.id);
  if (!items.some((i) => i.id === item.id)) throw new HttpError(404, "not_found", "Task not found");
  const runs = runTree(user, items).runs.filter((r) => r.itemId === item.id);
  const events = listRunEvents(user.id, { runIds: runs.map((r) => r.id), limit: 200 });
  const decisions = listDecisionRows(user.id, { itemIds: [item.id] }).filter((d) => d.state !== "withdrawn" && d.state !== "superseded");
  const moments = taskMoments(
    runs,
    events,
    decisions.filter((d) => d.state === "open" || d.state === "deferred"),
  );
  for (const d of decisions)
    if (d.answeredAt && d.answeredChoice)
      moments.push({
        id: `decided:${d.id}`,
        label: "Decided",
        tone: "ok",
        // Whether the agent has the answer (task threads E4): said only once the chat confirmed it.
        text: `${d.question.replace(/\s+/g, " ").trim()} → ${d.answeredChoice}${DELIVERY_WORD[d.delivery?.state ?? ""] ?? ""}`,
        at: d.answeredAt,
      });
  moments.push({
    id: `created:${item.id}`,
    label: "Captured",
    tone: "neutral",
    text: item.createdVia?.startsWith("agent:") ? `By @${item.createdVia.slice(6)}` : "By you",
    at: item.createdAt,
  });
  return { moments: moments.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id)).slice(0, 200) };
}

/**
 * Stop the work on a task: the turn in flight in its chat is asked to stop, and its open runs read "stopped by
 * you" at once (Stalled, with Resume). The owner's own tap, confirmed in place; Resume is how it is taken back.
 */
export async function stopTask(user: CurrentUser, itemId: string, correlationId: string, now = new Date()) {
  const row = ownedItem(user.id, itemId);
  const item = listItems(user.id).find((i) => i.id === row.id);
  if (!item || !isTask(item)) throw new HttpError(400, "bad_item", "Only a task can be stopped");
  const db = getDb();
  const at = now.toISOString();
  const open = db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.userId, user.id), eq(schema.agentRuns.itemId, item.id), inArray(schema.agentRuns.state, ["running", "waiting"])))
    .all();
  const sessionId = primarySessionOf(item);
  const turns =
    sessionId && can(user, "hermes.chat")
      ? db
          .select({ runId: schema.runs.runId, status: schema.runs.status })
          .from(schema.runs)
          .where(and(eq(schema.runs.userId, user.id), eq(schema.runs.sessionId, sessionId)))
          .all()
          .filter((r) => liveOfRun(r.status) === "running" || liveOfRun(r.status) === "waiting")
      : [];
  if (!open.length && !turns.length) throw new HttpError(409, "not_running", "Nothing is running on this task");
  db.transaction(
    (tx) => {
      for (const run of open) {
        tx.update(schema.agentRuns)
          .set({ state: "interrupted", summary: "Stopped by you", updatedAt: at, interruptedAt: at })
          .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.userId, user.id)))
          .run();
        recordRunEvent(tx, { userId: user.id, runId: run.id, type: "interrupted", summary: "Stopped by you", via: null });
      }
      event(tx, item.id, user.id, { kind: "agent_run", reason: "Stopped by you" });
    },
    { behavior: "immediate" },
  );
  // The assistant's own turn: best effort. The task already reads stopped; a turn that cannot be reached ends by itself.
  let asked = 0;
  for (const turn of turns) {
    try {
      await assistant.stopRun(user, turn.runId, correlationId);
      asked++;
    } catch {
      /* the run's own end is still recorded when it comes */
    }
  }
  audit({
    actor: user.id,
    action: "work.task_stop",
    source: "work",
    sourceRecord: item.id,
    result: "ok",
    correlationId,
    detail: { runs: open.length, turns: asked },
  });
  return { itemId: item.id, stopped: open.length, turns: asked };
}

/**
 * Mark finished work reviewed: each task is closed by the owner's one confirmed tap, and each close is its own
 * undoable edit (Undo reopens them all). A task that cannot be closed yet (a validation still to record) is left
 * as it is and named in `skipped`. Nothing is ever closed without this tap.
 */
export function markReviewed(user: CurrentUser, ids: readonly string[], correlationId: string) {
  const items = new Map(listItems(user.id).map((i) => [i.id, i]));
  const done: { id: string; opId: string | null }[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];
  for (const id of [...new Set(ids)]) {
    const item: WorkItem | undefined = items.get(id);
    if (!item || !isTask(item)) throw new HttpError(404, "not_found", "Task not found");
    if (isClosed(item.status)) continue;
    const out: OpOut = {};
    try {
      updateItem(user, id, { status: "settled", reason: "Reviewed" }, correlationId, out);
      done.push({ id, opId: out.op?.id ?? null });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      skipped.push({ id, title: item.title, reason: error.message });
    }
  }
  return { reviewed: done, skipped };
}
