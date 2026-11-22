"use client";

/**
 * One Hermes run stream per run, however many parts of the page are showing it.
 *
 * Hermes allows only a few connections in total, shared by every tab, pane and device
 * (docs/hermes-connection-budget.md). The server relay already fans one upstream stream out to its readers; this is
 * the browser's half of that: every reader of a run (`useRunStream`) shares one `EventSource` and one run state.
 * The stream opens with its first reader and closes shortly after its last one leaves.
 *
 * A closed or broken stream never implies completion: the stream reconciles with GET /runs/:id and reconnects from
 * the last seen sequence number until Hermes reports a terminal state.
 */
import { api } from "@/lib/client/api";
import { isTerminal, type RunEvent, type RunPhase, type RunView } from "@/lib/hermes";
import { aguiToRunEvents, isAguiEvent, newAguiReadState } from "@/lib/agui/reducer";
import { IDLE_RUN, reduceRun, type RunAction, type RunState } from "./run-state";

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 15000];
/** A tab hidden this long closes its run stream (it resumes from the last event when shown). */
export const HIDDEN_GRACE_MS = 30_000;
/**
 * A stream whose last reader left is kept this long before it closes, so a reader that comes straight back (a route
 * change that remounts the conversation, React StrictMode's second mount) picks it up instead of opening another.
 */
export const LINGER_MS = 1_000;

/** What readers render from. `finished` turns true once, after the terminal state is confirmed and the stream closed. */
export type RunSnapshot = { state: RunState; finished: boolean };

const streams = new Map<string, RunStream>();

/** How many run streams this page holds open or lingering (for tests and diagnostics). */
export const openRunStreams = () => streams.size;

/**
 * The shared stream for a run: the existing one when some reader already has it (its state is kept as it is), a new
 * one otherwise. Call `retain()` when a reader takes it and `release()` when that reader lets go.
 */
export function runStream(runId: string, phase: RunPhase = "running"): RunStream {
  const existing = streams.get(runId);
  if (existing) return existing;
  const created = new RunStream(runId, phase, () => {
    if (streams.get(runId) === created) streams.delete(runId);
  });
  streams.set(runId, created);
  return created;
}

export class RunStream {
  private snapshot: RunSnapshot;
  private readonly listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq: number | undefined;
  private attempts = 0;
  // AG-UI read state (tool names by synthesised id) for this run; survives reconnects.
  private readonly agui = newAguiReadState();
  // Text/reasoning deltas wait here and land once per frame (one render per frame, not per token).
  private queue: { event: RunEvent; seq?: number }[] = [];
  private cancelFrame: (() => void) | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private readers = 0;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    readonly runId: string,
    phase: RunPhase,
    private readonly onDispose: () => void,
  ) {
    this.snapshot = { state: reduceRun(IDLE_RUN, { type: "reset", runId, phase }), finished: false };
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
  }

  // ---- readers ------------------------------------------------------------------------------------------------
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;

  /** A reader takes the stream. */
  retain() {
    this.readers += 1;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  /**
   * A reader lets go. With no reader left the stream closes after `LINGER_MS`, or at once when `now` is set (the
   * reader is done with this run, not just unmounting).
   */
  release(now = false) {
    this.readers = Math.max(0, this.readers - 1);
    if (this.readers > 0 || this.disposed) return;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    // A finished run has nothing left to stream: there is no connection to keep for a returning reader.
    if (now || this.snapshot.finished) return this.dispose();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.readers === 0) this.dispose();
    }, LINGER_MS);
  }

  private dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dropQueued();
    this.closeSource();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.onDispose();
  }

  // ---- state --------------------------------------------------------------------------------------------------
  private set(next: RunSnapshot) {
    if (this.disposed || next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
  private dispatch(action: RunAction) {
    const state = reduceRun(this.snapshot.state, action);
    if (state !== this.snapshot.state) this.set({ ...this.snapshot, state });
  }

  private flush = () => {
    this.cancelFrame?.();
    this.cancelFrame = null;
    const items = this.queue;
    if (!items.length) return;
    this.queue = [];
    this.dispatch(items.length === 1 ? { type: "event", ...items[0]! } : { type: "events", items });
  };
  private enqueue(event: RunEvent, seq: number | undefined) {
    if (event.type !== "text.delta" && event.type !== "reasoning") {
      // Any other event flushes the queue first, so ordering (and terminal/approval handling) is unchanged.
      this.flush();
      this.dispatch({ type: "event", event, seq });
      return;
    }
    this.queue.push({ event, seq });
    if (this.cancelFrame) return;
    // rAF pauses in background tabs: fall back to a short timer so text still lands.
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      const id = requestAnimationFrame(this.flush);
      this.cancelFrame = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(this.flush, 100);
      this.cancelFrame = () => clearTimeout(id);
    }
  }
  private dropQueued() {
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.queue = [];
  }

  // ---- connection ---------------------------------------------------------------------------------------------
  private closeSource() {
    this.source?.close();
    this.source = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** The run is done: close the stream and tell readers once. */
  private finish() {
    if (this.snapshot.finished) return;
    this.closeSource();
    this.set({ ...this.snapshot, finished: true });
  }

  private async reconcile(): Promise<RunView | undefined> {
    try {
      const view = await api.get<RunView>(`/api/hermes/runs/${encodeURIComponent(this.runId)}`);
      this.dispatch({ type: "reconciled", view });
      return view;
    } catch {
      return undefined;
    }
  }

  private scheduleReconnect() {
    const n = this.attempts;
    if (n >= BACKOFF.length) {
      this.dispatch({ type: "phase", phase: "disconnected", error: "Lost connection to Hermes. Retry when ready." });
      return;
    }
    this.attempts = n + 1;
    this.dispatch({ type: "attempt", n: n + 1 });
    this.reconnectTimer = setTimeout(() => this.connect(), BACKOFF[n]);
  }

  private async onBroken() {
    this.flush();
    this.closeSource();
    if (this.disposed) return;
    this.dispatch({ type: "phase", phase: "reconnecting" });
    const view = await this.reconcile();
    if (this.disposed) return;
    if (view && isTerminal(view.status)) return this.finish();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.dispatch({ type: "phase", phase: "disconnected", error: "You're offline. Reconnecting when you're back." });
      return;
    }
    this.scheduleReconnect();
  }

  private connect() {
    // Where there is no EventSource (a server render, a unit test without one) the run keeps the phase it was given.
    if (this.disposed || typeof EventSource === "undefined") return;
    this.closeSource();
    // The server answers in AG-UI only while Settings → Agents enables it; both formats are read here.
    const q = this.lastSeq !== undefined ? `?format=agui&lastSeq=${this.lastSeq}` : "?format=agui";
    const source = new EventSource(`/api/hermes/runs/${encodeURIComponent(this.runId)}/events${q}`);
    this.source = source;
    // A chat opened straight into a background tab (Ctrl/Cmd-click) never sees a visibilitychange, so start the
    // hidden-tab release here too (#253).
    if (typeof document !== "undefined" && document.visibilityState === "hidden") this.onVisibility();
    source.onmessage = (msg) => {
      let raw: unknown;
      try {
        raw = JSON.parse(msg.data);
      } catch {
        return;
      }
      const events: RunEvent[] = isAguiEvent(raw) ? aguiToRunEvents(raw, this.agui) : [raw as RunEvent];
      const seq = msg.lastEventId && /^\d+$/.test(msg.lastEventId) ? Number(msg.lastEventId) : undefined;
      for (const ev of events) {
        if (ev.type === "stream.closed") {
          void this.onBroken();
          return;
        }
        if (seq !== undefined) this.lastSeq = seq;
        this.attempts = 0;
        this.enqueue(ev, seq);
        if (ev.type === "run.terminal") {
          // Confirm with the authoritative status before finalizing.
          void this.reconcile().then(() => this.finish());
        }
      }
    };
    source.onerror = () => {
      if (this.source === source) void this.onBroken();
    };
  }

  // ---- what a reader can ask for ------------------------------------------------------------------------------
  readonly stop = async () => {
    this.dispatch({ type: "phase", phase: "stopping" });
    try {
      const view = await api.post<RunView>(`/api/hermes/runs/${encodeURIComponent(this.runId)}/stop`);
      if (isTerminal(view.status)) {
        this.dispatch({ type: "reconciled", view });
        this.finish();
      }
    } catch (err) {
      this.dispatch({ type: "phase", phase: "stopping", error: (err as Error).message });
      void this.reconcile();
    }
  };

  readonly retry = () => {
    this.attempts = 0;
    this.dispatch({ type: "attempt", n: 0 });
    this.dispatch({ type: "phase", phase: "reconnecting" });
    this.connect();
  };

  // ---- the page going offline or into the background ---------------------------------------------------------------
  private readonly onOnline = () => {
    const phase = this.snapshot.state.phase;
    if (phase === "disconnected" || phase === "reconnecting") this.retry();
  };

  // A hidden tab keeps no Hermes connection: after a short grace the stream closes, and it reconnects from the last
  // seen event when the tab is visible again.
  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (this.hideTimer || !this.source) return;
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (!this.source || isTerminal(this.snapshot.state.phase)) return;
        this.flush();
        this.closeSource();
        this.paused = true;
      }, HIDDEN_GRACE_MS);
      return;
    }
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.paused) return;
    this.paused = false;
    void this.reconcile().then((view) => {
      if (this.disposed) return;
      if (view && isTerminal(view.status)) this.finish();
      else this.connect();
    });
  };
}
