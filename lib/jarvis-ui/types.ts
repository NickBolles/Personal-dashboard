/**
 * What POST /api/smart/hydrate returns per ref. Titles, dates and status come
 * from live Jarvis data, never from the model. Unknown, foreign and Finance
 * refs come back `unavailable` and get no actions.
 */
export type HydratedRef =
  | {
      ref: string;
      kind: "todo" | "item";
      title: string;
      /** YYYY-MM-DD (todos: due; items: target) */
      due?: string;
      status: string;
      /** "Google Tasks", or the item's area crumb */
      where?: string;
      href?: string;
      done?: boolean;
    }
  | { ref: string; unavailable: "unknown" | "finance" | "forbidden" };

export type HydrateResponse = { refs: Record<string, HydratedRef>; today: string };

export type AppliedEntry = {
  intentHash: string;
  intent: unknown;
  ok: boolean;
  message: string;
  at: string;
  /** idempotency key of the apply call that wrote it */
  key: string;
  undone?: boolean;
  /** what undo needs (previous due/status, created item id, work op id) */
  undo?: Record<string, unknown>;
};

export type SurfaceView = {
  id: string;
  specHash: string;
  state: Record<string, unknown>;
  applied: AppliedEntry[];
  readOnly: boolean;
};

export type ApplyResult = { intentHash: string; ok: boolean; message: string; code?: string };

export type SmartSettings = { enabled: boolean };

export const SMART_CAPABILITY = "jarvis-ui@1";
