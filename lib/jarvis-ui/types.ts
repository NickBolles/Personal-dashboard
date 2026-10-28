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
      timed?: boolean;
    }
  | {
      ref: string;
      kind: "metric";
      label: string;
      /** gauges: value of max (e.g. $ spent of the daily budget) */
      value?: number;
      max?: number;
      unit?: "usd" | "count";
      /** sparklines: oldest first */
      series?: { label: string; value: number }[];
      note: string;
      href?: string;
    }
  | {
      ref: string;
      kind: "calendar";
      /** fixed events in the plan's week (read-only) */
      events: { id: string; title: string; day: string; start?: string; end?: string; allDay: boolean }[];
      /** person turned calendar writes on and a writable calendar is configured */
      writable: boolean;
    }
  | {
      ref: string;
      kind: "pr";
      title: string;
      repo: string;
      number: number;
      state: "open" | "closed" | "merged";
      draft: boolean;
      url: string;
      headRef?: string;
      baseRef?: string;
      additions?: number;
      deletions?: number;
      files?: number;
      updatedAt?: string;
      checks: { name: string; state: "pass" | "fail" | "pending" | "skipped"; detail?: string }[];
      reviews: { who: string; state: "approved" | "changes_requested" | "commented" }[];
      /** GitHub's own merge check: true/false, or null while GitHub computes it */
      mergeable: boolean | null;
      mergeableState?: string;
      /** findings left by the Codex review bot (top-level review comments); null when unreadable */
      codexFindings: number | null;
      readiness: { done: number; total: number; blockers: string[] };
      /** the work item this PR is linked to */
      itemHref?: string;
    }
  | { ref: string; unavailable: "unknown" | "finance" | "forbidden" | "not_connected" | "error"; message?: string };

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
  /** "Already applied" (recorded only so a replay returns the full response) */
  noop?: boolean;
  code?: string;
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

export type SmartSettings = {
  enabled: boolean;
  /** calendar.block writes (spec §12a): off by default; each batch still needs its own approval */
  calendarWrites: boolean;
};

/** Jarvis-built workflow surfaces (no model): the brief, the week plan and PR cards. */
export const WORKFLOW_KINDS = ["brief", "week", "pr"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];
export type WorkflowResponse = { kind: WorkflowKind; sessionId: string; blockIndex: number; spec: import("./catalog").JarvisSpec; builtAt: string };

export const SMART_CAPABILITY = "jarvis-ui@1";

/** A hydrated todo or work item (the refs rows and blocks point at). */
export type TaskRef = Extract<HydratedRef, { kind: "todo" | "item" }>;
export const isTask = (h: HydratedRef | undefined): h is TaskRef => Boolean(h && "kind" in h && (h.kind === "todo" || h.kind === "item"));
