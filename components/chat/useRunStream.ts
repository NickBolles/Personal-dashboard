"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { api } from "@/lib/client/api";
import { isTerminal, type ApprovalRequest, type RunEvent, type RunPhase, type RunView } from "@/lib/hermes";

export type Activity =
  | { id: string; kind: "tool"; tool: string; preview?: string; result?: string; done: boolean; error?: boolean; startedAt: string; durationSec?: number }
  | { id: string; kind: "subagent"; goal?: string; summary?: string; status?: string; done: boolean; startedAt: string }
  | { id: string; kind: "commentary"; text: string; startedAt: string };

export type RunState = {
  runId?: string;
  phase: RunPhase;
  text: string;
  reasoning: string;
  activity: Activity[];
  approval?: ApprovalRequest;
  steerQueued: number;
  pendingSteer?: string;
  error?: string;
  output?: string;
  lastSeq?: number;
  attempts: number;
};

type Action =
  | { type: "reset"; runId?: string; phase?: RunPhase }
  | { type: "event"; event: RunEvent; seq?: number }
  | { type: "phase"; phase: RunPhase; error?: string }
  | { type: "reconciled"; view: RunView }
  | { type: "attempt"; n: number };

const initial: RunState = { phase: "completed", text: "", reasoning: "", activity: [], steerQueued: 0, attempts: 0 };

let seqCounter = 0;
const aid = () => `a${++seqCounter}`;

export function reduceRun(state: RunState, a: Action): RunState {
  switch (a.type) {
    case "reset":
      return { ...initial, runId: a.runId, phase: a.phase ?? (a.runId ? "running" : "completed") };
    case "attempt":
      return { ...state, attempts: a.n };
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
        output: v.output ?? state.output,
        error: v.error ?? (isTerminal(v.status) ? state.error : undefined),
        pendingSteer: v.pendingSteer ?? state.pendingSteer,
      };
    }
    case "event": {
      const e = a.event;
      const s = { ...state, lastSeq: a.seq ?? state.lastSeq, attempts: 0 };
      if (s.phase === "reconnecting" || s.phase === "disconnected" || s.phase === "starting" || s.phase === "queued") s.phase = "running";
      switch (e.type) {
        case "text.delta":
          return { ...s, text: s.text + e.delta };
        case "commentary":
          return e.text ? { ...s, activity: [...s.activity, { id: aid(), kind: "commentary", text: e.text, startedAt: new Date().toISOString() }] } : s;
        case "reasoning":
          return { ...s, reasoning: s.reasoning + e.text };
        case "tool.started":
          return { ...s, activity: [...s.activity, { id: aid(), kind: "tool", tool: e.tool, preview: e.preview, done: false, startedAt: e.at }] };
        case "tool.completed": {
          const idx = s.activity.findIndex((x) => x.kind === "tool" && x.tool === e.tool && !x.done);
          const done = { done: true, result: e.preview, error: e.error, durationSec: e.durationSec };
          if (idx === -1) return { ...s, activity: [...s.activity, { id: aid(), kind: "tool", tool: e.tool, startedAt: e.at, ...done }] };
          const next = [...s.activity];
          next[idx] = { ...(next[idx] as Extract<Activity, { kind: "tool" }>), ...done };
          return { ...s, activity: next };
        }
        case "subagent.started":
          return { ...s, activity: [...s.activity, { id: e.id ?? aid(), kind: "subagent", goal: e.goal, done: false, startedAt: e.at }] };
        case "subagent.completed": {
          const idx = s.activity.findIndex((x) => x.kind === "subagent" && (x.id === e.id || (!x.done && x.goal === e.goal)));
          if (idx === -1) return { ...s, activity: [...s.activity, { id: e.id ?? aid(), kind: "subagent", goal: e.goal, summary: e.summary, status: e.status, done: true, startedAt: e.at }] };
          const next = [...s.activity];
          next[idx] = { ...(next[idx] as Extract<Activity, { kind: "subagent" }>), summary: e.summary, status: e.status, done: true };
          return { ...s, activity: next };
        }
        case "approval.requested":
          return { ...s, phase: "waiting_for_approval", approval: { requestId: e.requestId, command: e.command, description: e.description, choices: e.choices } };
        case "approval.resolved":
          return { ...s, phase: s.phase === "stopping" ? "stopping" : "running", approval: undefined };
        case "steer.queued":
          return { ...s, steerQueued: s.steerQueued + 1 };
        case "run.terminal":
          return { ...s, phase: e.status, output: e.output ?? s.output, error: e.error, pendingSteer: e.pendingSteer, approval: undefined };
        default:
          return s;
      }
    }
  }
}

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 15000];

/**
 * Streams a Hermes run through the BFF relay. A closed or broken stream never
 * implies completion: we reconcile with GET /runs/:id and reconnect from the
 * last seen sequence number until Hermes reports a terminal state.
 */
export function useRunStream(onTerminal: (state: RunState) => void) {
  const [state, dispatch] = useReducer(reduceRun, initial);
  const es = useRef<EventSource | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  const terminalCb = useRef(onTerminal);
  useLayoutEffect(() => {
    stateRef.current = state;
    terminalCb.current = onTerminal;
  });
  const finished = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    es.current?.close();
    es.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const finish = useCallback(() => {
    const s = stateRef.current;
    if (s.runId && finished.current !== s.runId) {
      finished.current = s.runId;
      cleanup();
      setTimeout(() => terminalCb.current(stateRef.current), 0);
    }
  }, [cleanup]);

  const reconcile = useCallback(async (): Promise<RunView | undefined> => {
    const runId = stateRef.current.runId;
    if (!runId) return;
    try {
      const view = await api.get<RunView>(`/api/hermes/runs/${encodeURIComponent(runId)}`);
      dispatch({ type: "reconciled", view });
      return view;
    } catch {
      return undefined;
    }
  }, []);

  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    const n = stateRef.current.attempts;
    if (n >= BACKOFF.length) {
      dispatch({ type: "phase", phase: "disconnected", error: "Lost connection to Hermes. Retry when ready." });
      return;
    }
    dispatch({ type: "attempt", n: n + 1 });
    timer.current = setTimeout(() => connectRef.current(), BACKOFF[n]);
  }, []);

  const onBroken = useCallback(async () => {
    cleanup();
    if (!stateRef.current.runId) return;
    dispatch({ type: "phase", phase: "reconnecting" });
    const view = await reconcile();
    if (view && isTerminal(view.status)) return finish();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      dispatch({ type: "phase", phase: "disconnected", error: "You're offline. Reconnecting when you're back." });
      return;
    }
    scheduleReconnect();
  }, [cleanup, reconcile, finish, scheduleReconnect]);

  const connect = useCallback(() => {
    const s = stateRef.current;
    if (!s.runId) return;
    cleanup();
    const q = s.lastSeq !== undefined ? `?lastSeq=${s.lastSeq}` : "";
    const source = new EventSource(`/api/hermes/runs/${encodeURIComponent(s.runId)}/events${q}`);
    es.current = source;
    source.onmessage = (msg) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      if (ev.type === "stream.closed") {
        void onBroken();
        return;
      }
      const seq = msg.lastEventId && /^\d+$/.test(msg.lastEventId) ? Number(msg.lastEventId) : undefined;
      dispatch({ type: "event", event: ev, seq });
      if (ev.type === "run.terminal") {
        // Confirm with the authoritative status before finalizing.
        void reconcile().then(() => finish());
      }
    };
    source.onerror = () => {
      if (es.current === source) void onBroken();
    };
  }, [cleanup, onBroken, reconcile, finish]);
  useLayoutEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const start = useCallback(
    (runId: string, phase: RunPhase = "running") => {
      cleanup();
      finished.current = null;
      dispatch({ type: "reset", runId, phase });
      setTimeout(() => connectRef.current(), 0);
    },
    [cleanup],
  );

  const stop = useCallback(async () => {
    const runId = stateRef.current.runId;
    if (!runId) return;
    dispatch({ type: "phase", phase: "stopping" });
    try {
      const view = await api.post<RunView>(`/api/hermes/runs/${encodeURIComponent(runId)}/stop`);
      if (isTerminal(view.status)) {
        dispatch({ type: "reconciled", view });
        finish();
      }
    } catch (err) {
      dispatch({ type: "phase", phase: "stopping", error: (err as Error).message });
      void reconcile();
    }
  }, [finish, reconcile]);

  const retry = useCallback(() => {
    dispatch({ type: "attempt", n: 0 });
    dispatch({ type: "phase", phase: "reconnecting" });
    connectRef.current();
  }, []);

  useEffect(() => {
    const on = () => {
      if (stateRef.current.runId && (stateRef.current.phase === "disconnected" || stateRef.current.phase === "reconnecting")) retry();
    };
    window.addEventListener("online", on);
    return () => {
      window.removeEventListener("online", on);
      cleanup();
    };
  }, [cleanup, retry]);

  const active = Boolean(state.runId) && !isTerminal(state.phase);
  return { state, start, stop, retry, active, clear: () => dispatch({ type: "reset" }) };
}
