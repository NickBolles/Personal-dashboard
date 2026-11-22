import "server-only";
import { and, eq, gte, like } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import type { Capable } from "@/server/access";
import { HttpError } from "@/server/http/errors";
import { detectSensitivity } from "@/server/ai/rules";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { resolveAgent, resolveAgentForNode } from "@/server/agents/routing";
import * as assistant from "@/server/assistant";
import { sessionProfile } from "@/integrations/hermes/service";
import { getPreferences } from "@/server/settings";
import { areaDefaultsFor } from "@/server/references";
import { effectiveAutonomy, policyInstructions } from "@/lib/away";
import { liveOfRun } from "@/lib/agent-runs";
import { canHaveChat } from "@/lib/task-chat";
import { isClosed, type WorkItem } from "@/lib/work";
import { localDate } from "@/lib/time";
import { config } from "@/server/config";
import { globalCoordinatorArea } from "./coordinator";
import { ensureTaskChat, replaceTaskChat } from "./primary-chat";
import { finishRegisteredRun, registerAgentRun } from "./registered-runs";
import { event, ownedItem, recordOp, updateItem, type OpOut } from "./store";

/**
 * Bots work in the task's chat (task threads, step 2). Three verbs, called by agents through MCP
 * (server/agent-access/task-tools.ts): start a task (open its chat with a brief and register the run there),
 * steer a task (post into its chat) and hand a task to another bot. Nothing here settles, spends, sends outside
 * Jarvis or touches a device: it only opens or continues a conversation with an agent about one task.
 */

type Viewer = CurrentUser & Capable;
/** The agent that called: the owner narrowed to the token's scopes, and the profile it acts as. */
export type TaskCaller = { user: Viewer; profile: string; tokenId: string | null };

/** How many tasks all bots together may start for one owner per day. A start costs a model run. */
export const TASK_STARTS_PER_DAY = 40;

export type TaskRunDeps = {
  ensureChat: typeof ensureTaskChat;
  replaceChat: typeof replaceTaskChat;
  startRun: typeof assistant.startRun;
  steerRun: typeof assistant.steerRun;
  sessionProfile: (sessionId: string) => string | null;
};
// The assistant's functions are looked up when they are called, not when this module loads.
const defaultDeps: TaskRunDeps = {
  ensureChat: ensureTaskChat,
  replaceChat: replaceTaskChat,
  startRun: (...args) => assistant.startRun(...args),
  steerRun: (...args) => assistant.steerRun(...args),
  sessionProfile,
};

const taskPath = (id: string) => `/areas?item=${encodeURIComponent(id)}&tab=chat`;

/** The Hermes run that is in flight in this conversation, if any (Jarvis' own record of runs it started). */
export function activeRun(userId: string, sessionId: string) {
  return (
    getDb()
      .select({ runId: schema.runs.runId, status: schema.runs.status })
      .from(schema.runs)
      .where(and(eq(schema.runs.userId, userId), eq(schema.runs.sessionId, sessionId)))
      .all()
      .find((r) => liveOfRun(r.status) === "running" || liveOfRun(r.status) === "waiting") ?? null
  );
}

/** The task as work that can be started: a task or project, open, in an area where AI is on. */
function startable(user: CurrentUser, item: WorkItem) {
  if (!canHaveChat(item)) throw new HttpError(400, "bad_item", "Start work on a task or project, not on an area, a note or a conversation");
  if (item.archived || isClosed(item.status)) throw new HttpError(409, "closed", "This task is closed. Ask the owner to reopen it first");
  const row = ownedItem(user.id, item.id);
  const area = areaOf(user, row.id);
  if (area && effectiveAutonomy({ title: area.title, systemKey: area.systemKey, settings: area.settings }) === "off")
    throw new HttpError(409, "ai_off", "AI is off in this area");
}

function areaOf(user: CurrentUser, itemId: string) {
  const db = getDb();
  let row = ownedItem(user.id, itemId);
  for (let n = 0; row.parentId && n < 100; n++) row = ownedItem(user.id, row.parentId, db);
  if (row.parentId !== null) return null;
  let settings: WorkItem["settings"] = null;
  try {
    settings = row.settings ? (JSON.parse(row.settings) as WorkItem["settings"]) : null;
  } catch {
    settings = null;
  }
  return { id: row.id, title: row.title, systemKey: row.systemKey, settings };
}

/**
 * Who works on a task: the agent it is assigned to, else the agent that answers for its area, else (an area
 * without a coordinator) the Chief of staff, else the default assistant. Only profiles that are routed count.
 */
export function workerFor(user: CurrentUser, item: Pick<WorkItem, "id" | "assignee">): string | null {
  const assigned = item.assignee?.startsWith("agent:") ? resolveAgent(item.assignee.slice(6)) : null;
  if (assigned?.routed) return assigned.profile;
  const area = resolveAgentForNode(user.id, item.id);
  if (area.routed) return area.profile;
  const chief = globalCoordinatorArea(user);
  const fallback = chief ? resolveAgentForNode(user.id, chief.id) : null;
  return fallback?.routed ? fallback.profile : null;
}

function startsToday(userId: string, now: Date) {
  const day = localDate(now, config.timezone);
  return getDb()
    .select({ startedAt: schema.agentRuns.startedAt })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.userId, userId),
        like(schema.agentRuns.delegationId, "task:%"),
        gte(schema.agentRuns.startedAt, new Date(now.getTime() - 36 * 3_600_000).toISOString()),
      ),
    )
    .all()
    .filter((r) => localDate(new Date(r.startedAt), config.timezone) === day).length;
}

/** What every brief ends with: where this is tracked and how the working agent reports back (docs/agent-tools.md). */
export function briefFooter(item: Pick<WorkItem, "id" | "title">, ref: string) {
  return [
    "---",
    `Jarvis task: ${item.title} (item ${item.id}), run ${ref}. This conversation is the task's chat: do the work here.`,
    `Report each key moment with jarvis_run_event (runId ${ref}, type "progress", moment "found" | "made" | "blocked" | "handed_off"): one line of at most 140 characters each. Report at least one before you finish.`,
    `When you finish or fail, call jarvis_run_update (runId ${ref}) with state done or failed and a one-line summary.`,
    `To ask the owner, call jarvis_raise_decision (itemId ${item.id}, runId ${ref}).`,
  ].join("\n");
}

export type StartedTask = {
  itemId: string;
  title: string;
  runId: string;
  ref: string;
  sessionId: string;
  /** who works on it (null: the default assistant) */
  worker: string | null;
  /** where the owner opens it */
  href: string;
  undoOpId: string | null;
};

/**
 * Start (or hand off) a task: its chat is opened with the brief, on the agent that works on it, and the run is
 * registered there. With `toProfile` the task is first assigned to that agent; if its chat is with another agent,
 * a new chat on `toProfile` becomes the task's primary chat (the old one stays under Other chats).
 * Undoable by the owner: the run is stopped and what the hand-off changed is put back.
 */
export async function startTask(
  caller: TaskCaller,
  item: WorkItem,
  input: { brief: string; title?: string; toProfile?: string },
  correlationId: string,
  deps: TaskRunDeps = defaultDeps,
  now = new Date(),
): Promise<StartedTask> {
  const { user } = caller;
  startable(user, item);
  const brief = input.brief.trim();
  if (!brief) throw new HttpError(400, "brief", "Say what should happen");
  if (detectSensitivity(brief) === "credentials") throw new HttpError(409, "credentials", "A brief can't carry credentials");
  if (input.toProfile && !resolveAgent(input.toProfile).routed)
    throw new HttpError(400, "unknown_profile", "That agent has no route in Settings → Agents, so it can't be handed work");
  if (startsToday(user.id, now) >= TASK_STARTS_PER_DAY) throw new HttpError(409, "daily_cap", "The daily cap on started tasks is reached");

  const prevAssignee = item.assignee ?? null;
  const prevPrimary = item.primarySessionId ?? null;
  const handoff = !!input.toProfile;
  const worker = input.toProfile ?? workerFor(user, item);
  if (prevPrimary && activeRun(user.id, prevPrimary))
    throw new HttpError(409, "already_working", "This task's chat has a run in flight. Steer it with jarvis_steer_task, or wait for it to end");

  // Assign first (a hand-off says who has it), then open the chat on that agent.
  if (handoff && prevAssignee !== `agent:${input.toProfile}`) updateItem(user, item.id, { assignee: `agent:${input.toProfile}` }, correlationId);
  let sessionId: string;
  let replacedChat = false;
  if (prevPrimary && (!handoff || deps.sessionProfile(prevPrimary) === worker)) sessionId = prevPrimary;
  else if (prevPrimary) {
    sessionId = (await deps.replaceChat(user, item.id, worker, correlationId)).sessionId;
    replacedChat = true;
  } else sessionId = (await deps.ensureChat(user, item.id, undefined, correlationId, { profile: worker })).sessionId;

  const title = (input.title?.trim() || item.title).slice(0, 200);
  const chatProfile = deps.sessionProfile(sessionId) ?? worker ?? "default";
  const registered = registerAgentRun(
    user,
    chatProfile,
    { itemId: item.id, title, hermesSessionId: sessionId, delegationId: `task:${item.id}:${now.getTime().toString(36)}` },
    correlationId,
    caller.tokenId,
    now,
  );
  const where = areaDefaultsFor(user, sessionId);
  const prefs = getPreferences().hermes;
  const settings = where?.settings ?? null;
  const area = areaOf(user, item.id);
  const autonomy = area ? effectiveAutonomy({ title: area.title, systemKey: area.systemKey, settings: area.settings }) : "propose";
  let hermesRunId: string | null = null;
  try {
    const run = await deps.startRun(
      user,
      {
        sessionId,
        input: maskAccountNumbers(`${brief}\n\n${briefFooter(item, registered.ref)}`),
        instructions: maskAccountNumbers([settings?.instructions, policyInstructions(autonomy)].filter(Boolean).join("\n\n")) || undefined,
        idempotencyKey: `task:${registered.runId}`,
        model: settings?.defaultModel || prefs.defaultModel || undefined,
        provider: settings?.defaultProvider || prefs.defaultProvider || undefined,
      },
      correlationId,
    );
    hermesRunId = run.runId;
  } catch (e) {
    // The run never started: say so on the task instead of leaving a run that reads as working.
    finishRegisteredRun(
      user,
      registered.runId,
      "failed",
      `Couldn't start: ${e instanceof Error ? e.message : "the assistant did not answer"}`.slice(0, 300),
      now,
    );
    throw e;
  }
  const out: OpOut = {};
  getDb().transaction((tx) => {
    event(tx, item.id, user.id, { kind: "agent_run", reason: handoff ? `Handed off to @${input.toProfile}: ${title}` : `Started in its chat: ${title}` });
    recordOp(
      tx,
      user.id,
      item.id,
      handoff ? "task_handoff" : "task_start",
      { runId: registered.runId, hermesRunId, sessionId, replacedChat, prevPrimary, prevAssignee, toProfile: input.toProfile ?? null },
      out,
    );
  });
  audit({
    actor: `agent:${caller.profile}`,
    action: handoff ? "agent.task_handoff" : "agent.task_start",
    source: "agent",
    sourceRecord: item.id,
    result: "ok",
    correlationId,
    detail: { run: registered.ref, worker },
  });
  return {
    itemId: item.id,
    title: item.title,
    runId: registered.runId,
    ref: registered.ref,
    sessionId,
    worker,
    href: taskPath(item.id),
    undoOpId: out.op?.id ?? null,
  };
}

/**
 * Steer a task: the words go into the task's chat. While its agent is working they are guidance for that run;
 * otherwise they start its next turn. Only for a steer the owner asked for: a bot's own idea is a proposal
 * (it raises a decision), never a message it sends by itself.
 */
export async function steerTask(
  caller: TaskCaller,
  item: WorkItem,
  input: { message: string },
  correlationId: string,
  deps: TaskRunDeps = defaultDeps,
): Promise<{ itemId: string; title: string; sessionId: string; delivered: "guidance" | "message"; href: string }> {
  const { user } = caller;
  startable(user, item);
  const message = input.message.trim();
  if (!message) throw new HttpError(400, "message", "Say what to tell it");
  if (detectSensitivity(message) === "credentials") throw new HttpError(409, "credentials", "A steer can't carry credentials");
  const sessionId = item.primarySessionId;
  if (!sessionId) throw new HttpError(409, "no_chat", "This task has no chat yet. Start it with jarvis_start_task");
  const running = activeRun(user.id, sessionId);
  const text = maskAccountNumbers(message);
  let delivered: "guidance" | "message";
  if (running && liveOfRun(running.status) === "running") {
    await deps.steerRun(user, running.runId, text, correlationId);
    delivered = "guidance";
  } else if (running) {
    throw new HttpError(409, "waiting", "Its agent is waiting on the owner. Nothing can be sent until that is answered");
  } else {
    await deps.startRun(user, { sessionId, input: text, idempotencyKey: `steer:${item.id}:${correlationId}` }, correlationId);
    delivered = "message";
  }
  getDb().transaction((tx) => event(tx, item.id, user.id, { kind: "agent_run", reason: `Steered: ${message.replace(/\s+/g, " ").slice(0, 140)}` }));
  audit({
    actor: `agent:${caller.profile}`,
    action: "agent.task_steer",
    source: "agent",
    sourceRecord: item.id,
    result: "ok",
    correlationId,
    detail: { delivered },
  });
  return { itemId: item.id, title: item.title, sessionId, delivered, href: taskPath(item.id) };
}

/** What "Check in" sends: a status question the agent can answer in a few lines, then carry on. */
export const CHECK_IN_TEXT =
  "Status check from the owner: in two or three lines, say what is done, what is left and anything you are blocked on. Then carry on.";

/**
 * "Check in" on a silent task (D6): ask its agent for a status, in the task's chat. It is a message the owner
 * sends with their own tap, never automatic: guidance for the turn in flight, else the next message.
 */
export async function checkInTask(
  user: Viewer,
  item: WorkItem,
  correlationId: string,
  deps: TaskRunDeps = defaultDeps,
): Promise<{ itemId: string; sessionId: string; delivered: "guidance" | "message" }> {
  startable(user, item);
  const sessionId = item.primarySessionId;
  if (!sessionId) throw new HttpError(409, "no_chat", "This task has no chat to ask in yet");
  const running = activeRun(user.id, sessionId);
  let delivered: "guidance" | "message";
  if (running && liveOfRun(running.status) === "running") {
    await deps.steerRun(user, running.runId, CHECK_IN_TEXT, correlationId);
    delivered = "guidance";
  } else if (running) {
    throw new HttpError(409, "waiting", "Its agent is waiting on you. Answer that first");
  } else {
    await deps.startRun(user, { sessionId, input: CHECK_IN_TEXT, idempotencyKey: `checkin:${item.id}:${correlationId}` }, correlationId);
    delivered = "message";
  }
  getDb().transaction((tx) => event(tx, item.id, user.id, { kind: "agent_run", reason: "Checked in" }));
  audit({ actor: user.id, action: "work.task_check_in", source: "work", sourceRecord: item.id, result: "ok", correlationId, detail: { delivered } });
  return { itemId: item.id, sessionId, delivered };
}
