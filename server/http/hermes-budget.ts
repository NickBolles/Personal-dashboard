import { AsyncLocalStorage } from "node:async_hooks";
import { processSingleton } from "@/server/singleton";

/**
 * Hermes connection budget (one per Jarvis process).
 *
 * Production reaches Hermes through Traefik (`hermes-api.ai.nickbolles.com`), whose
 * `inFlightReq` middleware allows 64 requests in flight for the whole host (raised from 10 on
 * 2026-11-08) and whose `rateLimit` allows ~50 req/s (burst 200). Anything above answers 429
 * "max connections reached" before Hermes sees it. Long SSE relays hold a slot for the whole
 * run, and the conversation-index warmer used to fan out ~35 requests at once every few
 * minutes, so a chat send landing in that second failed.
 *
 * Every Hermes request takes a slot here first:
 * - `interactive`: user-facing requests (create a chat, send, approve, stop). Served first.
 * - `stream`: run event relays; at most `maxStreams` at a time, the rest wait ("Queued").
 * - `background`: syncs, warmers, list fan-outs; never use the last `reserve` slots, so a
 *   send always finds room.
 * A token bucket keeps the request rate under the proxy's rate limit.
 */
export type HermesLane = "interactive" | "stream" | "background";

export type BudgetLimits = { max: number; maxStreams: number; reserve: number; ratePerSec: number; burst: number };

function envInt(name: string, fallback: number, min: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback; // unset or blank (Number("") would be 0)
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Defaults (constants; env overrides stay for emergencies). 24 in flight keeps well under the
 * proxy's 64; half of them may be run streams; 2 are kept for people (background work never
 * takes them).
 */
export const DEFAULT_MAX_CONNECTIONS = 24;
export const DEFAULT_MAX_STREAMS = 12;
export const DEFAULT_RESERVED_INTERACTIVE = 2;

export function budgetLimits(): BudgetLimits {
  const max = envInt("JARVIS_HERMES_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS, 1);
  const reserve = Math.min(max - 1, envInt("JARVIS_HERMES_RESERVED_INTERACTIVE", DEFAULT_RESERVED_INTERACTIVE, 0));
  const wantStreams = envInt("JARVIS_MAX_STREAMS", max === DEFAULT_MAX_CONNECTIONS ? DEFAULT_MAX_STREAMS : Math.max(1, Math.floor(max / 2)), 1);
  return {
    max,
    // Streams hold a slot for the whole run: keep at least one slot (or the interactive
    // reserve, if larger) free of them so Stop/approve/status calls always get through, even
    // when JARVIS_MAX_STREAMS >= the connection limit (#251). One stream is always allowed.
    maxStreams: Math.max(1, Math.min(wantStreams, max - Math.max(1, reserve))),
    reserve,
    ratePerSec: envInt("JARVIS_HERMES_RATE_PER_SEC", 20, 1),
    burst: envInt("JARVIS_HERMES_RATE_BURST", 40, 1),
  };
}

type Waiter = { lane: HermesLane; grant: () => void; seq: number };
type State = {
  active: number;
  streams: number;
  background: number;
  waiters: Waiter[];
  seq: number;
  tokens: number;
  refillAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  limits: BudgetLimits | null;
};

const state = () =>
  processSingleton<State>("hermes_budget", () => ({
    active: 0,
    streams: 0,
    background: 0,
    waiters: [],
    seq: 0,
    tokens: -1,
    refillAt: 0,
    timer: null,
    limits: null,
  }));

const limits = () => (state().limits ??= budgetLimits());

const RANK: Record<HermesLane, number> = { interactive: 0, stream: 1, background: 2 };

function fits(s: State, l: BudgetLimits, lane: HermesLane) {
  if (s.active >= l.max) return false;
  if (lane === "stream") return s.streams < l.maxStreams && s.active < l.max;
  if (lane === "background") return s.active < l.max - l.reserve;
  return true;
}

function refill(s: State, l: BudgetLimits, now: number) {
  if (s.tokens < 0) {
    s.tokens = l.burst;
    s.refillAt = now;
    return;
  }
  const add = ((now - s.refillAt) / 1000) * l.ratePerSec;
  if (add > 0) {
    s.tokens = Math.min(l.burst, s.tokens + add);
    s.refillAt = now;
  }
}

function take(s: State, lane: HermesLane) {
  s.active++;
  s.tokens -= 1;
  if (lane === "stream") s.streams++;
  if (lane === "background") s.background++;
}

/** Grant queued requests in priority order (interactive, stream, background; FIFO within a lane). */
function pump() {
  const s = state();
  const l = limits();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.waiters.sort((a, b) => RANK[a.lane] - RANK[b.lane] || a.seq - b.seq);
  for (let i = 0; i < s.waiters.length;) {
    const w = s.waiters[i]!;
    if (!fits(s, l, w.lane)) {
      i++;
      continue;
    }
    refill(s, l, Date.now());
    if (s.tokens < 1) {
      // Out of rate tokens: try again when the next one arrives.
      s.timer = setTimeout(pump, Math.ceil(((1 - s.tokens) / l.ratePerSec) * 1000));
      return;
    }
    s.waiters.splice(i, 1);
    take(s, w.lane);
    w.grant();
  }
}

export type Slot = { release: () => void; waitedMs: number; lane: HermesLane };

/**
 * Wait for a slot in `lane`. Resolves with a release function (idempotent). Rejects with the
 * signal's reason if it aborts while waiting. `onQueued` fires once if the request has to wait.
 */
export function acquireHermesSlot(lane: HermesLane, opts: { signal?: AbortSignal; onQueued?: () => void } = {}): Promise<Slot> {
  const s = state();
  const startedAt = Date.now();
  opts.signal?.throwIfAborted();
  return new Promise<Slot>((resolve, reject) => {
    let released = false;
    const slot: Slot = {
      lane,
      waitedMs: 0,
      release: () => {
        if (released) return;
        released = true;
        s.active--;
        if (lane === "stream") s.streams--;
        if (lane === "background") s.background--;
        pump();
      },
    };
    const waiter: Waiter = {
      lane,
      seq: s.seq++,
      grant: () => {
        opts.signal?.removeEventListener("abort", onAbort);
        slot.waitedMs = Date.now() - startedAt;
        resolve(slot);
      },
    };
    const onAbort = () => {
      const i = s.waiters.indexOf(waiter);
      if (i >= 0) s.waiters.splice(i, 1);
      reject(opts.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      pump();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    s.waiters.push(waiter);
    pump();
    if (s.waiters.includes(waiter)) opts.onQueued?.();
  });
}

export function hermesBudgetStats() {
  const s = state();
  return {
    active: s.active,
    streams: s.streams,
    background: s.background,
    queued: s.waiters.length,
    queuedStreams: s.waiters.filter((w) => w.lane === "stream").length,
    limits: limits(),
  };
}

/** Tests: forget all slots and re-read limits from env. */
export function __resetHermesBudget(l?: Partial<BudgetLimits>) {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  Object.assign(s, { active: 0, streams: 0, background: 0, waiters: [], seq: 0, tokens: -1, refillAt: 0, timer: null });
  s.limits = { ...budgetLimits(), ...l };
}

const laneStore = processSingleton("hermes_lane_store", () => new AsyncLocalStorage<HermesLane>());

/** Run `fn` with every Hermes request inside it (that doesn't name a lane) in `lane`. */
export function withHermesLane<T>(lane: HermesLane, fn: () => T): T {
  return laneStore.run(lane, fn);
}

export function currentHermesLane(): HermesLane {
  return laneStore.getStore() ?? "interactive";
}

/** A Traefik/Hermes 429 means "not admitted": nothing ran upstream, so any request may be retried. */
export function isBusyStatus(status: number | undefined) {
  return status === 429;
}

/** Backoff before retry `n` (0-based): ~300 ms, 700 ms, 1.5 s, 3 s (+ up to 30 % jitter). */
export function busyBackoffMs(n: number, random = Math.random) {
  const base = [300, 700, 1500, 3000][Math.min(n, 3)]!;
  return Math.round(base * (1 + 0.3 * random()));
}

/** Retries after a 429 before giving up: a person waits ~5 s, background work gives up sooner. */
export function busyRetries(lane: HermesLane) {
  return lane === "background" ? 2 : 4;
}
