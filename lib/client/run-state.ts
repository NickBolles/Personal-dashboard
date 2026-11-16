/**
 * What a Hermes run looks like to the page while it streams: the state every reader of a run renders from, and the
 * pure reducer that folds run events into it. The connection that feeds it is lib/client/run-streams.ts; React reads
 * it through components/chat/useRunStream.ts.
 */
import { isTerminal, type ApprovalRequest, type ClarifyRequest, type RunEvent, type RunPhase, type RunView, type SubagentIdentity } from "@/lib/hermes";
import { toolResultState } from "@/lib/tool-presentation";

export type Activity =
  | {
      id: string;
      callId?: string;
      kind: "tool";
      tool: string;
      preview?: string;
      result?: string;
      done: boolean;
      error?: boolean;
      startedAt: string;
      durationSec?: number;
    }
  | ({ id: string; kind: "subagent"; goal?: string; summary?: string; status?: string; done: boolean; startedAt: string } & SubagentIdentity)
  | { id: string; kind: "commentary"; text: string; startedAt: string };

export type RunState = {
  runId?: string;
  phase: RunPhase;
  text: string;
  reasoning: string;
  activity: Activity[];
  approval?: ApprovalRequest;
  /** A Hermes clarify question waiting for an answer (the run stays "running" meanwhile). */
  clarify?: ClarifyRequest;
  steerQueued: number;
  pendingSteer?: string;
  error?: string;
  output?: string;
  lastSeq?: number;
  attempts: number;
  /** Why the run shows "Queued": Hermes' own queue, or Jarvis waiting for a free Hermes connection. */
  queueReason?: "connections";
};

export type RunAction =
  | { type: "reset"; runId?: string; phase?: RunPhase }
  | { type: "event"; event: RunEvent; seq?: number }
  /** Text/reasoning deltas coalesced per animation frame (one render per frame, not per token). */
  | { type: "events"; items: { event: RunEvent; seq?: number }[] }
  | { type: "phase"; phase: RunPhase; error?: string }
  | { type: "reconciled"; view: RunView }
  | { type: "attempt"; n: number };

/** No run: what a reader shows before one starts and after it is cleared. */
export const IDLE_RUN: RunState = { phase: "completed", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0 };

let seqCounter = 0;
const aid = () => `a${++seqCounter}`;

export function reduceRun(state: RunState, a: RunAction): RunState {
  switch (a.type) {
    case "reset":
      return { ...IDLE_RUN, runId: a.runId, phase: a.phase ?? (a.runId ? "running" : "completed") };
    case "attempt":
      return { ...state, attempts: a.n };
    case "events":
      return a.items.reduce((s, it) => reduceRun(s, { type: "event", event: it.event, seq: it.seq }), state);
    case "phase":
      // Never regress out of a terminal state, and keep "stopping" until Hermes confirms.
      if (isTerminal(state.phase) && !isTerminal(a.phase)) return state;
      if (state.phase === "stopping" && (a.phase === "running" || a.phase === "reconnecting")) return { ...state, error: a.error };
      return { ...state, phase: a.phase, error: a.error ?? state.error };
    case "reconciled": {
      const v = a.view;
      const phase = state.phase === "stopping" && !isTerminal(v.status) ? "stopping" : v.status;
      return {
        ...state,
        phase,
        approval: v.status === "waiting_for_approval" ? (v.pendingApproval ?? state.approval) : undefined,
        // GET status is authoritative: no pending clarify there means it was answered or withdrawn.
        clarify: isTerminal(v.status) ? undefined : v.pendingClarify,
        output: v.output ?? state.output,
        error: v.error ?? (isTerminal(v.status) ? state.error : undefined),
        pendingSteer: v.pendingSteer ?? state.pendingSteer,
      };
    }
    case "event": {
      const e = a.event;
      const s = { ...state, lastSeq: a.seq ?? state.lastSeq, attempts: 0 };
      if (e.type === "run.queued") return isTerminal(s.phase) || s.phase === "stopping" ? s : { ...s, phase: "queued", queueReason: e.reason };
      if (e.type === "unknown" && s.phase === "queued") return s;
      if (s.phase === "reconnecting" || s.phase === "disconnected" || s.phase === "starting" || s.phase === "queued") s.phase = "running";
      switch (e.type) {
        case "text.delta":
          return { ...s, text: s.text + e.delta };
        case "commentary":
          return e.text ? { ...s, activity: [...s.activity, { id: aid(), kind: "commentary", text: e.text, startedAt: new Date().toISOString() }] } : s;
        case "reasoning":
          return { ...s, reasoning: s.reasoning + e.text };
        case "tool.started":
          if (e.callId && s.activity.some((x) => x.kind === "tool" && x.callId === e.callId)) return s;
          return {
            ...s,
            activity: [...s.activity, { id: aid(), callId: e.callId, kind: "tool", tool: e.tool, preview: e.preview, done: false, startedAt: e.at }],
          };
        case "tool.completed": {
          const idx = s.activity.findIndex((x) => x.kind === "tool" && (e.callId ? x.callId === e.callId : x.tool === e.tool && !x.done));
          const done = { done: true, result: e.preview, error: toolResultState(e.preview, e.error) === "failed", durationSec: e.durationSec };
          if (idx === -1) return { ...s, activity: [...s.activity, { id: aid(), callId: e.callId, kind: "tool", tool: e.tool, startedAt: e.at, ...done }] };
          const next = [...s.activity];
          next[idx] = { ...(next[idx] as Extract<Activity, { kind: "tool" }>), ...done };
          return { ...s, activity: next };
        }
        case "subagent.started": {
          const fields = subagentFields(e);
          // A resumed stream re-announces subagents still open; keep the original activity.
          const idx = subagentIndex(s.activity, e);
          if (idx !== -1) {
            const next = [...s.activity];
            next[idx] = { ...(next[idx] as Extract<Activity, { kind: "subagent" }>), ...fields };
            return { ...s, activity: next };
          }
          return { ...s, activity: [...s.activity, { id: e.id ?? aid(), kind: "subagent", goal: e.goal, done: false, startedAt: e.at, ...fields }] };
        }
        case "subagent.completed": {
          const fields = subagentFields(e);
          const idx = subagentIndex(s.activity, e);
          if (idx === -1)
            return {
              ...s,
              activity: [
                ...s.activity,
                { id: e.id ?? aid(), kind: "subagent", goal: e.goal, summary: e.summary, status: e.status, done: true, startedAt: e.at, ...fields },
              ],
            };
          const next = [...s.activity];
          next[idx] = { ...(next[idx] as Extract<Activity, { kind: "subagent" }>), ...fields, summary: e.summary, status: e.status, done: true };
          return { ...s, activity: next };
        }
        case "approval.requested":
          return {
            ...s,
            phase: "waiting_for_approval",
            approval: { requestId: e.requestId, command: e.command, description: e.description, choices: e.choices },
          };
        case "approval.resolved":
          return { ...s, phase: s.phase === "stopping" ? "stopping" : "running", approval: undefined };
        case "clarify.requested":
          return { ...s, clarify: { requestId: e.requestId, question: e.question, choices: e.choices, multiSelect: e.multiSelect } };
        case "clarify.resolved":
          return !e.requestId || s.clarify?.requestId === e.requestId ? { ...s, clarify: undefined } : s;
        case "steer.queued":
          return { ...s, steerQueued: s.steerQueued + 1 };
        case "run.terminal":
          return { ...s, phase: e.status, output: e.output ?? s.output, error: e.error, pendingSteer: e.pendingSteer, approval: undefined, clarify: undefined };
        default:
          return s;
      }
    }
  }
}

function subagentIndex(activity: Activity[], e: SubagentIdentity & { id?: string; goal?: string }) {
  const identified = Boolean(e.id || e.childSessionId || (e.delegationId && e.taskIndex !== undefined));
  return activity.findIndex(
    (x) =>
      x.kind === "subagent" &&
      ((e.id && x.id === e.id) ||
        (e.childSessionId && x.childSessionId === e.childSessionId) ||
        (e.delegationId && e.taskIndex !== undefined && x.delegationId === e.delegationId && x.taskIndex === e.taskIndex) ||
        (!identified && e.goal !== undefined && !x.done && x.goal === e.goal)),
  );
}

function subagentFields(e: SubagentIdentity): SubagentIdentity {
  return Object.fromEntries(
    Object.entries({
      childSessionId: e.childSessionId,
      delegationId: e.delegationId,
      parentId: e.parentId,
      taskIndex: e.taskIndex,
      taskCount: e.taskCount,
      durationSec: e.durationSec,
    }).filter(([, v]) => v !== undefined),
  );
}
