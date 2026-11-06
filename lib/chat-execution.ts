/**
 * Phase 2 shared contract: execution records (child agents, delegations, background
 * processes, Jarvis runs/jobs) that belong to ONE parent chat.
 *
 * Server: GET /api/hermes/sessions/[id]/execution -> ChatExecutionResponse.
 * Client: Running tab, tray counts and inline child links render these records.
 *
 * Honesty rules (owner acceptance, /opt/data/worktrees/jarvis-phase2-chat-acceptance.md):
 * - `state: "unknown"` when the source does not say; never infer success from parent completion.
 * - a source that could not be read is reported in `sources` as "unavailable"/"stale",
 *   never as an empty list.
 * - `href` is an INTERNAL Jarvis path only (/chat/<id>, /areas?item=<id>); host transcript
 *   paths go in `transcriptPath` and are rendered as copyable text, never as links.
 */

export type ExecSource =
  | "subagent" // Hermes delegate_task child agent (subagent.* events / Subagent: child sessions)
  | "process" // Hermes background process (terminal background, process notices)
  | "fork" // Jarvis fork of this chat (session_meta.forked_from_session_id)
  | "jarvis_run" // Jarvis-started run recorded against a work item
  | "registered_run"; // MCP jarvis_run_start registration naming this session

export type ExecState = "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";

export type ExecLink = { url: string; label?: string | null; kind: "github" | "artifact" | "web" | "internal" };

export type ExecutionRecord = {
  /** Stable dedupe key: `${source}:${id}`. */
  key: string;
  source: ExecSource;
  id: string;
  title: string;
  state: ExecState;
  startedAt?: string | null;
  endedAt?: string | null;
  updatedAt?: string | null;
  /** Current step text, only when the source reports one. */
  step?: string | null;
  /** 0..1, only when the source reports a computable fraction. */
  progress?: number | null;
  summary?: string | null;
  error?: string | null;
  childSessionId?: string | null;
  /** Hermes profile the child session lives on (null = default profile). */
  childProfile?: string | null;
  delegationId?: string | null;
  /** Internal Jarvis link (child chat or work item); null when not navigable. */
  href?: string | null;
  links?: ExecLink[];
  /** Copyable host path; never rendered as a link. */
  transcriptPath?: string | null;
};

export type ExecSourceStatus = {
  source: "hermes_children" | "transcript" | "relations" | "jarvis_runs" | "registered_runs";
  state: "ok" | "unavailable" | "stale";
  at?: string | null;
  detail?: string | null;
};

export type ChatExecutionResponse = {
  sessionId: string;
  /** Immediate parent when THIS chat is itself a child (for return-to-parent). */
  parent: { id: string; title: string | null; href: string } | null;
  records: ExecutionRecord[];
  sources: ExecSourceStatus[];
  fetchedAt: string;
};

export const ACTIVE_EXEC_STATES: readonly ExecState[] = ["running", "waiting"];

export function isActiveExec(r: Pick<ExecutionRecord, "state">): boolean {
  return ACTIVE_EXEC_STATES.includes(r.state);
}

/** Merge records from several sources, keeping the most informative/terminal state per key. */
export function mergeExecutionRecords(...lists: ExecutionRecord[][]): ExecutionRecord[] {
  const rank: Record<ExecState, number> = { unknown: 0, waiting: 1, running: 2, cancelled: 3, failed: 3, completed: 3 };
  const out = new Map<string, ExecutionRecord>();
  for (const list of lists)
    for (const r of list) {
      const prev = out.get(r.key);
      if (!prev) {
        out.set(r.key, r);
        continue;
      }
      const winner = rank[r.state] > rank[prev.state] ? r : rank[r.state] < rank[prev.state] ? prev : (r.updatedAt ?? "") >= (prev.updatedAt ?? "") ? r : prev;
      const loser = winner === r ? prev : r;
      out.set(r.key, {
        ...loser,
        ...Object.fromEntries(Object.entries(winner).filter(([, v]) => v !== undefined && v !== null)),
        links: dedupeLinks([...(prev.links ?? []), ...(r.links ?? [])]),
      } as ExecutionRecord);
    }
  return [...out.values()].sort((a, b) => (b.startedAt ?? b.updatedAt ?? "").localeCompare(a.startedAt ?? a.updatedAt ?? ""));
}

function dedupeLinks(links: ExecLink[]): ExecLink[] {
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}
