"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTerminal, type RunPhase } from "@/lib/hermes";
import { IDLE_RUN, type RunState } from "@/lib/client/run-state";
import { runStream, type RunSnapshot, type RunStream } from "@/lib/client/run-streams";

// The run state and its reducer live in lib/client/run-state.ts and the connection in lib/client/run-streams.ts;
// they are re-exported here because this file is where the rest of the app has always imported them from.
export { reduceRun, type Activity, type RunState } from "@/lib/client/run-state";
export { HIDDEN_GRACE_MS } from "@/lib/client/run-streams";

const IDLE: RunSnapshot = { state: IDLE_RUN, finished: false };
const getIdle = () => IDLE;
const noStream = () => () => {};

/**
 * Reads a Hermes run as it streams through the BFF relay.
 *
 * The stream itself is shared (lib/client/run-streams.ts): every reader of the same run, in any pane, gets the same
 * state from one connection, so mounting a second reader never opens a second stream. `start` joins the run's stream
 * (opening it if this is the first reader); unmounting or `clear` lets go of it.
 *
 * `onTerminal` is called once per run this reader followed, after Hermes confirmed the terminal state.
 */
export function useRunStream(onTerminal: (state: RunState) => void) {
  const [stream, setStream] = useState<RunStream | null>(null);
  // The stream this reader currently counts as a reader of. It trails `stream` only across an unmount.
  const held = useRef<RunStream | null>(null);
  const { state, finished } = useSyncExternalStore(stream ? stream.subscribe : noStream, stream ? stream.getSnapshot : getIdle, getIdle);

  const terminalCb = useRef(onTerminal);
  useLayoutEffect(() => {
    terminalCb.current = onTerminal;
  });
  const notified = useRef<RunStream | null>(null);
  useEffect(() => {
    if (stream && finished && isTerminal(state.phase) && notified.current !== stream) {
      notified.current = stream;
      terminalCb.current(state);
    }
  }, [stream, finished, state]);

  const start = useCallback((runId: string, phase: RunPhase = "running") => {
    if (held.current?.runId === runId) return;
    held.current?.release();
    const next = runStream(runId, phase);
    next.retain();
    held.current = next;
    notified.current = null;
    setStream(next);
  }, []);

  const clear = useCallback(() => {
    // Done with this run (not just unmounting): with no other reader its stream closes now.
    held.current?.release(true);
    held.current = null;
    setStream(null);
  }, []);

  useEffect(() => {
    // An unmount lets go of the stream; a remount of the same reader (StrictMode, a kept-alive subtree) takes it again.
    if (stream && held.current !== stream) {
      stream.retain();
      held.current = stream;
    }
    return () => {
      if (stream && held.current === stream) {
        stream.release();
        held.current = null;
      }
    };
  }, [stream]);

  const stop = useCallback(async () => {
    await held.current?.stop();
  }, []);
  const retry = useCallback(() => {
    held.current?.retry();
  }, []);

  const active = Boolean(state.runId) && !isTerminal(state.phase);
  return { state, start, stop, retry, active, clear };
}
