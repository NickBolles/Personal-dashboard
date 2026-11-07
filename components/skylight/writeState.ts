import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";

/**
 * Optimistic row state for confirmed Skylight writes, shared by every surface that renders a chore
 * (Today, Todos, the Skylight page, the Chief of staff tray card). Pure: the store in `writeStore.ts`
 * owns timers; tests drive this reducer directly.
 *
 *   confirm → pending (shimmer, checkbox drawn) ─ok→ leaving (strike + collapse, ≤250 ms) ─settle→ done
 *                     └─error→ failed (rollback shake) ─settle→ (gone: the row is back as it was)
 *   done ─undo→ undoing (shimmer) ─ok→ restored (reverse: row re-enters) ─server agrees→ (gone)
 *                                 └─error→ done (stays done; the undo bar reports why)
 *
 * Only `chore.complete`, `chore.skip` and `chore.reopen` change where a row sits, so only those are
 * optimistic about status; every other op just shows pending/failed on its row.
 */
export type WritePhase = "pending" | "leaving" | "done" | "failed" | "undoing" | "restored";
export type WriteEntry = { phase: WritePhase; op: SkylightWriteOp; at: number; writeId?: string };
export type WriteState = Readonly<Record<string, WriteEntry>>;

export type WriteEvent =
  | { type: "confirm"; key: string; op: SkylightWriteOp; at: number }
  | { type: "success"; key: string; writeId?: string; at: number }
  | { type: "error"; key: string; at: number }
  | { type: "undo"; key: string; at: number }
  | { type: "undone"; key: string; at: number }
  | { type: "undo-error"; key: string; at: number }
  /** Animation finished (or reduced motion): leaving → done; failed → cleared (row back as it was). */
  | { type: "settle"; key: string; at: number }
  /** Fresh server data agrees with the write (or it went stale): drop the overlay. */
  | { type: "clear"; key: string };

/** Ops whose optimistic result moves the row out of (or back into) the open list. */
export const MOVES = new Set<SkylightWriteOp["op"]>(["chore.complete", "chore.skip", "chore.reopen", "list.check", "list.uncheck"]);

export function writeReducer(state: WriteState, ev: WriteEvent): WriteState {
  const cur = state[ev.key];
  const put = (entry: WriteEntry): WriteState => ({ ...state, [ev.key]: entry });
  const drop = (): WriteState => {
    if (!cur) return state;
    const next = { ...state };
    delete next[ev.key];
    return next;
  };
  switch (ev.type) {
    case "confirm":
      // One write per row at a time (a double tap must not send two).
      if (cur && (cur.phase === "pending" || cur.phase === "undoing")) return state;
      return put({ phase: "pending", op: ev.op, at: ev.at });
    case "success":
      if (cur?.phase !== "pending") return state;
      return put({ ...cur, phase: MOVES.has(cur.op.op) ? "leaving" : "done", at: ev.at, writeId: ev.writeId });
    case "error":
      if (cur?.phase !== "pending") return state;
      return put({ ...cur, phase: "failed", at: ev.at });
    case "undo":
      if (!cur || (cur.phase !== "done" && cur.phase !== "leaving")) return state;
      return put({ ...cur, phase: "undoing", at: ev.at });
    case "undone":
      if (cur?.phase !== "undoing") return state;
      return put({ ...cur, phase: "restored", at: ev.at });
    case "undo-error":
      if (cur?.phase !== "undoing") return state;
      return put({ ...cur, phase: "done", at: ev.at });
    case "settle":
      if (cur?.phase === "leaving") return put({ ...cur, phase: "done", at: ev.at });
      if (cur?.phase === "failed") return drop();
      return state;
    case "clear":
      // Never drop a row mid-request: its spinner/rollback still needs the entry.
      if (cur && (cur.phase === "pending" || cur.phase === "undoing")) return state;
      return drop();
  }
}

/** Status a row should show: the server's, unless a write in flight / just landed says otherwise. */
export function optimisticStatus(action: NextAction, entry: WriteEntry | undefined): NextAction["status"] | "skipped" {
  if (!entry || !MOVES.has(entry.op.op)) return action.status;
  const target = entry.op.op === "chore.reopen" || entry.op.op === "list.uncheck" ? "open" : entry.op.op === "chore.skip" ? "skipped" : "completed";
  const original = target === "open" ? "completed" : "open";
  switch (entry.phase) {
    case "pending":
    case "leaving":
    case "failed":
      // Still in its original list (pending draws the tick, leaving collapses, failed shakes back).
      return original === "completed" && action.status === "completed" ? "completed" : action.status;
    case "done":
    case "undoing":
      return target;
    case "restored":
      return original;
  }
}

/** Is the checkbox drawn checked right now (pending completes count, failed ones roll back)? */
export function optimisticChecked(action: NextAction, entry: WriteEntry | undefined): boolean {
  if (entry && MOVES.has(entry.op.op)) {
    const completes = entry.op.op === "chore.complete" || entry.op.op === "list.check";
    if (entry.phase === "pending" || entry.phase === "leaving" || entry.phase === "done" || entry.phase === "undoing") return completes;
    if (entry.phase === "restored") return !completes;
  }
  return action.status === "completed";
}

/**
 * Apply the overlay to a list of actions: rows a landed write completed show as completed (today), skipped rows
 * disappear, reopened/undone rows show as open. Input is never mutated.
 */
export function applyOverlay(actions: NextAction[], state: WriteState, today: string): NextAction[] {
  const out: NextAction[] = [];
  for (const a of actions) {
    const entry = state[a.id];
    const status = optimisticStatus(a, entry);
    if (status === "skipped") continue;
    if (status === a.status) {
      out.push(a);
      continue;
    }
    const ref = a.skylight;
    out.push({
      ...a,
      status,
      ...(status === "completed" ? { primaryAction: undefined, updatedAt: new Date(entry!.at).toISOString() } : {}),
      ...(ref?.kind === "chore" ? { skylight: { ...ref, completedOn: status === "completed" ? today : undefined } } : {}),
    });
  }
  return out;
}

/** Undo stays possible this long after a write lands, so its overlay entry must survive (reverse animation). */
export const UNDO_WINDOW_MS = 10_500;

/**
 * Overlay entries that can go: fresh server data agrees with the write and its undo window is over (done), or the
 * server shows the undone state again (restored). Anything older than `maxAgeMs` goes regardless.
 */
export function settledKeys(actions: NextAction[], state: WriteState, now: number, maxAgeMs = 60_000): string[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return Object.entries(state)
    .filter(([key, e]) => {
      if (e.phase !== "done" && e.phase !== "restored") return false;
      if (now - e.at > maxAgeMs) return true;
      if (!MOVES.has(e.op.op)) return e.phase === "restored" || now - e.at > UNDO_WINDOW_MS;
      const a = byId.get(key);
      const target = e.op.op === "chore.reopen" || e.op.op === "list.uncheck" ? "open" : "completed";
      const original = target === "open" ? "completed" : "open";
      if (e.phase === "restored") return a?.status === original;
      if (now - e.at <= UNDO_WINDOW_MS) return false;
      return e.op.op === "chore.skip" ? !a || a.status !== "open" : a?.status === target;
    })
    .map(([key]) => key);
}
