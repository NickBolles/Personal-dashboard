/** Normalized Hermes models shared by the BFF and the UI. */

export type RunPhase =
  | "starting"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "reconnecting"
  | "disconnected";

export const TERMINAL_PHASES: RunPhase[] = ["completed", "failed", "cancelled", "interrupted"];
export const isTerminal = (p: string) => (TERMINAL_PHASES as string[]).includes(p);

export type ApprovalRequest = {
  requestId?: string;
  command?: string;
  description?: string;
  choices: ("once" | "session" | "always" | "deny")[];
};

export type RunEvent =
  | { type: "text.delta"; seq?: number; delta: string }
  | { type: "commentary"; seq?: number; text: string }
  | { type: "reasoning"; seq?: number; text: string }
  | { type: "tool.started"; seq?: number; tool: string; preview?: string; at: string }
  | { type: "tool.completed"; seq?: number; tool: string; preview?: string; durationSec?: number; error?: boolean; at: string }
  | { type: "subagent.started"; seq?: number; id?: string; goal?: string; at: string }
  | { type: "subagent.completed"; seq?: number; id?: string; goal?: string; summary?: string; status?: string; at: string }
  | ({ type: "approval.requested"; seq?: number; at: string } & ApprovalRequest)
  | { type: "approval.resolved"; seq?: number; choice?: string; requestId?: string; at: string }
  | { type: "steer.queued"; seq?: number; at: string }
  | {
      type: "run.terminal";
      seq?: number;
      status: "completed" | "failed" | "cancelled" | "interrupted";
      output?: string;
      error?: string;
      pendingSteer?: string;
      at: string;
    }
  | { type: "replay.truncated"; oldestSeq?: number }
  | { type: "stream.closed"; reason: "upstream_closed" | "error"; message?: string }
  | { type: "unknown"; seq?: number; event: string };

export type SessionSummary = {
  id: string;
  title: string;
  preview?: string;
  startedAt?: string;
  lastActiveAt?: string;
  messageCount?: number;
  parentSessionId?: string;
  lineageRootId?: string;
  endReason?: string;
  pinned: boolean;
  archived: boolean;
  source?: string;
  model?: string;
  /** Jarvis-side lineage when a fork was approximated ("fork from here") */
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
  activeRun?: { runId: string; status: string; pendingApproval?: ApprovalRequest };
};

export type TimelineItem =
  | { kind: "user"; id: string; text: string; at?: string }
  | { kind: "assistant"; id: string; text: string; at?: string; reasoning?: string }
  | { kind: "tool"; id: string; tool: string; summary: string; detail?: string; at?: string; error?: boolean }
  | { kind: "system"; id: string; text: string; at?: string };

export type RunView = {
  runId: string;
  sessionId: string;
  status: RunPhase;
  output?: string;
  error?: string;
  pendingSteer?: string;
  pendingApproval?: ApprovalRequest;
};

export const TOOL_LABELS: Record<string, string> = {
  terminal: "Ran a command",
  web_search: "Searched the web",
  web_extract: "Read a web page",
  read_file: "Read a file",
  write_file: "Wrote a file",
  patch: "Edited a file",
  memory: "Updated memory",
  delegate_task: "Delegated to a subagent",
  browser_navigate: "Opened a page",
  send_message: "Sent a message",
  todo: "Updated a plan",
};

export function toolLabel(tool: string) {
  return TOOL_LABELS[tool] ?? `Used ${tool.replace(/_/g, " ")}`;
}
