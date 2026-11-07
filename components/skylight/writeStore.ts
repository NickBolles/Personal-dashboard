"use client";

import { useSyncExternalStore } from "react";
import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { settledKeys, writeReducer, type WriteEvent, type WriteState } from "./writeState";

/** Every motion here is ≤250 ms; reduced motion settles on the next tick (instant, never blocks input). */
export const MOTION_MS = 240;

let state: WriteState = {};
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Short haptic tick where supported (Android Chrome); silently nothing elsewhere. */
export function haptic(pattern: number | number[] = 8) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" && !reducedMotion()) navigator.vibrate(pattern);
  } catch {
    /* optional */
  }
}

function emit() {
  for (const l of listeners) l();
}

function settleLater(key: string) {
  const old = timers.get(key);
  if (old) clearTimeout(old);
  timers.set(
    key,
    setTimeout(
      () => {
        timers.delete(key);
        dispatch({ type: "settle", key, at: Date.now() });
      },
      reducedMotion() ? 0 : MOTION_MS,
    ),
  );
}

export function dispatch(ev: WriteEvent) {
  const next = writeReducer(state, ev);
  if (next === state) return false;
  state = next;
  const phase = state[ev.key]?.phase;
  if (phase === "leaving" || phase === "failed") settleLater(ev.key);
  emit();
  return true;
}

export const skylightWrites = {
  confirm: (key: string, op: SkylightWriteOp) => dispatch({ type: "confirm", key, op, at: Date.now() }),
  success: (key: string, writeId?: string) => dispatch({ type: "success", key, writeId, at: Date.now() }),
  error: (key: string) => dispatch({ type: "error", key, at: Date.now() }),
  undo: (key: string) => dispatch({ type: "undo", key, at: Date.now() }),
  undone: (key: string) => dispatch({ type: "undone", key, at: Date.now() }),
  undoError: (key: string) => dispatch({ type: "undo-error", key, at: Date.now() }),
  /** Fresh server rows arrived: drop overlay entries they now agree with. */
  reconcile: (actions: NextAction[]) => {
    for (const key of settledKeys(actions, state, Date.now())) dispatch({ type: "clear", key });
  },
  get: () => state,
  /** Tests only. */
  reset: () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    state = {};
    emit();
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const snapshot = () => state;
const empty: WriteState = {};

/** The shared overlay (same state in the tray card and the page under it). */
export function useSkylightWriteState(): WriteState {
  return useSyncExternalStore(subscribe, snapshot, () => empty);
}
