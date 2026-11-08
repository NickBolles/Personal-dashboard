/**
 * "Actions taken" (coordinator parity, board jarvis-coordinator-parity-20261107).
 *
 * Pure parser: turns the tool steps of a Hermes transcript into compact action chips, grouped
 * per assistant reply. Source = the durable timeline Jarvis already loads (no new storage):
 * Jarvis MCP tools appear as `mcp__jarvis__jarvis_<tool>` (any `mcp__<server>__` prefix is
 * accepted) and their results carry `item.id` / `undoOpId` / `runId`; `delegate_task` results
 * carry `delegation_id` + `subagent_ids`. Unknown or failed tool results produce no chip.
 *
 * Links are INTERNAL Jarvis paths only (/areas?item=<id>) or the https URL the agent linked.
 */
import type { TimelineItem } from "@/lib/hermes";

export type ActionKind =
  | "created" // jarvis_create_item
  | "updated" // jarvis_update_item
  | "note" // jarvis_add_note
  | "linked" // jarvis_link
  | "decision" // jarvis_raise_decision
  | "change_request" // jarvis_request_change
  | "run_started" // jarvis_run_start
  | "run_updated" // jarvis_run_update
  | "filed" // jarvis_file_conversation
  | "device_proposal" // jarvis_propose_device_change
  | "quick_action" // jarvis_add_quick_action (proposal)
  | "delegated"; // delegate_task spawn (N sub-agents)

export type ChatAction = {
  /** stable: `${toolStepId}:${kind}` */
  id: string;
  kind: ActionKind;
  /** short verb label, e.g. "Created", "Decision", "2 sub-agents" */
  label: string;
  /** object title when known (item title, link title, goal) */
  title: string | null;
  itemId: string | null;
  runId: string | null;
  undoOpId: string | null;
  /** internal jump link (/areas?item=…) or the https URL that was linked */
  href: string | null;
  /** delegate_task: id + sub-agent count */
  delegationId?: string | null;
  count?: number;
  at: string | null;
};

/** One assistant reply's actions: every tool step between the previous user message and the reply. */
export type ReplyActions = { replyId: string; actions: ChatAction[] };

export const ACTION_LABEL: Record<ActionKind, string> = {
  created: "Created",
  updated: "Updated",
  note: "Note",
  linked: "Linked",
  decision: "Decision",
  change_request: "Asked to change",
  run_started: "Run started",
  run_updated: "Run updated",
  filed: "Filed chat",
  device_proposal: "Device proposal",
  quick_action: "Quick action proposed",
  delegated: "Sub-agents",
};

const TOOL_KIND: Record<string, ActionKind> = {
  jarvis_create_item: "created",
  jarvis_update_item: "updated",
  jarvis_add_note: "note",
  jarvis_link: "linked",
  jarvis_raise_decision: "decision",
  jarvis_request_change: "change_request",
  jarvis_run_start: "run_started",
  jarvis_run_update: "run_updated",
  jarvis_file_conversation: "filed",
  jarvis_propose_device_change: "device_proposal",
  jarvis_add_quick_action: "quick_action",
};

const ITEM_ID = /^wk_[A-Za-z0-9-]{1,80}$/;
const OP_ID = /^op_[A-Za-z0-9-]{1,80}$/;
const RUN_ID = /^arun_[A-Za-z0-9-]{1,80}$/;

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {});
const str = (x: unknown) => (typeof x === "string" && x ? x : null);

/** The bare tool name: strips `mcp__<server>__` / `functions.` prefixes. */
export function toolBaseName(tool: string): string {
  const t = tool.replace(/^functions\./, "");
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(t);
  return m ? m[1]! : t;
}

/**
 * Tool results arrive wrapped (`<untrusted_tool_result …> preface {"result": "<json>"} </…>`) or bare.
 * Returns the innermost JSON object, or null.
 */
export function parseToolResult(detail: string | undefined | null): Obj | null {
  if (!detail || detail.length > 65536) return null;
  let text = detail;
  const close = text.lastIndexOf("</untrusted_tool_result>");
  if (close >= 0) text = text.slice(0, close);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    const o = obj(value);
    if (typeof o.result === "string") {
      try {
        value = JSON.parse(o.result);
        continue;
      } catch {
        return null;
      }
    }
    if (o.result && typeof o.result === "object") {
      value = o.result;
      continue;
    }
    break;
  }
  const out = obj(value);
  return Object.keys(out).length ? out : null;
}

function parseArgs(input: string | undefined): Obj {
  if (!input) return {};
  try {
    return obj(JSON.parse(input));
  } catch {
    return {};
  }
}

const itemHref = (id: string | null) => (id ? `/areas?item=${encodeURIComponent(id)}` : null);

/** One tool step → zero or one action. Errors and unknown tools give null. */
export function actionFromTool(step: Extract<TimelineItem, { kind: "tool" }>): ChatAction | null {
  if (step.error) return null;
  const base = toolBaseName(step.tool);
  const args = parseArgs(step.input);
  const res = parseToolResult(step.detail);
  if (base === "delegate_task") {
    if (!res) return null;
    const action = str(res.action) ?? str(args.action);
    if (action && action !== "spawn") return null; // list/steer/stop are control, not new work
    const ids = Array.isArray(res.subagent_ids) ? res.subagent_ids.length : 0;
    const results = Array.isArray(res.results) ? res.results.length : 0;
    const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
    const count = ids || results || tasks || (str(args.goal) ? 1 : 0);
    if (!count) return null;
    const goal = str(args.goal) ?? (Array.isArray(args.tasks) ? str(obj(args.tasks[0]).goal) : null);
    return {
      id: `${step.id}:delegated`,
      kind: "delegated",
      label: count === 1 ? "1 sub-agent" : `${count} sub-agents`,
      title: goal ? goal.slice(0, 200) : null,
      itemId: null,
      runId: null,
      undoOpId: null,
      href: null,
      delegationId: str(res.delegation_id),
      count,
      at: step.at ?? null,
    };
  }
  const kind = TOOL_KIND[base];
  if (!kind || !res) return null;
  if (res.error || res.ok === false) return null;
  const item = obj(res.item);
  const link = obj(res.link);
  const decision = obj(res.decision);
  const itemId =
    [str(item.id), str(res.itemId), str(decision.itemId), str(args.itemId), kind === "created" ? null : str(args.id)].find(
      (v): v is string => !!v && ITEM_ID.test(v),
    ) ?? null;
  const undo = str(res.undoOpId);
  const run = str(res.runId) ?? str(args.runId);
  const linkUrl = str(link.url) ?? str(args.url);
  const href = kind === "linked" && linkUrl && /^https:\/\//.test(linkUrl) ? linkUrl : itemHref(itemId);
  const title =
    str(item.title) ??
    (kind === "linked" ? (str(link.title) ?? str(args.title) ?? linkUrl) : null) ??
    str(args.title) ??
    str(args.question) ??
    str(decision.question) ??
    null;
  return {
    id: `${step.id}:${kind}`,
    kind,
    label: ACTION_LABEL[kind],
    title: title ? title.slice(0, 200) : null,
    itemId,
    runId: run && RUN_ID.test(run) ? run : null,
    undoOpId: undo && OP_ID.test(undo) ? undo : null,
    href,
    at: step.at ?? null,
  };
}

/**
 * Group actions by the assistant reply they led to. Tool steps after the last assistant
 * message (a run still working) are returned under replyId "live".
 * `run_updated` chips collapse into their `run_started` chip when both are in one reply.
 */
export function actionsByReply(timeline: readonly TimelineItem[]): ReplyActions[] {
  const out: ReplyActions[] = [];
  let pending: ChatAction[] = [];
  const flush = (replyId: string) => {
    if (!pending.length) return;
    const started = new Set(pending.filter((a) => a.kind === "run_started" && a.runId).map((a) => a.runId));
    const actions = pending.filter((a) => !(a.kind === "run_updated" && a.runId && started.has(a.runId)));
    out.push({ replyId, actions });
    pending = [];
  };
  for (const t of timeline) {
    if (t.kind === "tool") {
      const a = actionFromTool(t);
      if (a) pending.push(a);
    } else if (t.kind === "assistant") flush(t.id);
  }
  flush("live");
  return out;
}

/** Every action in a conversation, newest first (for a conversation-level Actions list). */
export function conversationActions(timeline: readonly TimelineItem[]): ChatAction[] {
  return actionsByReply(timeline)
    .flatMap((r) => r.actions)
    .reverse();
}
