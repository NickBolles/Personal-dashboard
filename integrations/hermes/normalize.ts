import type { ApprovalRequest, RunEvent, SessionSummary, TimelineItem } from "@/lib/hermes";
import type { HermesMessage, HermesRunEvent, HermesSession } from "./types";

const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

const SECRETISH = /(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)(?:(bearer|basic)\s+)?([^\s"',]{6,})/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Defence in depth: Hermes redacts previews, but never forward anything that still looks like a credential. */
export function scrub(text: string | undefined) {
  return text?.replace(SECRETISH, (_m, k, sep, scheme) => `${k}${sep}${scheme ? `${scheme} ` : ""}[redacted]`).replace(BEARER, "$1 [redacted]");
}

export function normalizeChoices(choices: unknown): ApprovalRequest["choices"] {
  const allowed = ["once", "session", "always", "deny"] as const;
  const list = Array.isArray(choices) ? choices.filter((c): c is ApprovalRequest["choices"][number] => allowed.includes(c)) : [];
  return list.length ? list : ["once", "deny"];
}

export function normalizeApproval(raw: Record<string, unknown> | null | undefined): ApprovalRequest | undefined {
  if (!raw) return undefined;
  return {
    requestId: str(raw.request_id),
    command: scrub(str(raw.command)),
    description: scrub(str(raw.description)),
    choices: normalizeChoices(raw.choices),
  };
}

export function normalizeRunEvent(e: HermesRunEvent): RunEvent {
  const seq = num(e.seq);
  const at = iso(num(e.timestamp)) ?? new Date().toISOString();
  switch (e.event) {
    case "message.delta":
      return { type: "text.delta", seq, delta: str(e.delta) ?? "" };
    case "message.interim":
      return { type: "commentary", seq, text: str(e.text) ?? "" };
    case "reasoning.available":
      return { type: "reasoning", seq, text: str(e.text) ?? "" };
    case "tool.started":
      return { type: "tool.started", seq, tool: str(e.tool) ?? "tool", preview: scrub(str(e.preview)), at };
    case "tool.completed":
      return {
        type: "tool.completed",
        seq,
        tool: str(e.tool) ?? "tool",
        preview: scrub(str(e.preview)),
        durationSec: num(e.duration),
        error: Boolean(e.error),
        at,
      };
    case "subagent.start":
      return { type: "subagent.started", seq, id: str(e.subagent_id), goal: str(e.goal), at };
    case "subagent.complete":
      return {
        type: "subagent.completed",
        seq,
        id: str(e.subagent_id),
        goal: str(e.goal),
        summary: scrub(str(e.summary)),
        status: str(e.status),
        at,
      };
    case "approval.request":
      return { type: "approval.requested", seq, at, ...normalizeApproval(e)! };
    case "approval.responded":
      return { type: "approval.resolved", seq, choice: str(e.choice), requestId: str(e.request_id), at };
    case "run.steered":
      return { type: "steer.queued", seq, at };
    case "run.completed":
      return { type: "run.terminal", seq, status: "completed", output: str(e.output), pendingSteer: str(e.pending_steer), at };
    case "run.failed":
      return { type: "run.terminal", seq, status: "failed", error: str(e.error), pendingSteer: str(e.pending_steer), at };
    case "run.cancelled":
      return { type: "run.terminal", seq, status: "cancelled", pendingSteer: str(e.pending_steer), at };
    case "run.interrupted":
      return { type: "run.terminal", seq, status: "interrupted", error: str(e.error), at };
    case "replay.truncated":
      return { type: "replay.truncated", oldestSeq: num(e.oldest_retained_seq) };
    default:
      return { type: "unknown", seq, event: e.event };
  }
}

export function sessionTitle(s: Pick<HermesSession, "title" | "preview" | "id">) {
  return s.title?.trim() || s.preview?.trim().slice(0, 60) || "Untitled conversation";
}

export function normalizeSession(s: HermesSession): SessionSummary {
  return {
    id: s.id,
    title: sessionTitle(s),
    preview: s.preview ?? undefined,
    startedAt: iso(s.started_at),
    lastActiveAt: iso(s.last_active ?? s.ended_at ?? s.started_at),
    messageCount: s.message_count ?? undefined,
    parentSessionId: s.parent_session_id ?? undefined,
    lineageRootId: s._lineage_root_id ?? undefined,
    endReason: s.end_reason ?? undefined,
    pinned: Boolean(s.pinned),
    archived: Boolean(s.archived),
    source: s.source ?? undefined,
    model: s.model ?? undefined,
  };
}

function contentText(content: HermesMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function summarizeArgs(args?: string) {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const first = parsed.command ?? parsed.query ?? parsed.url ?? parsed.path ?? parsed.goal;
    return scrub(typeof first === "string" ? first : JSON.stringify(parsed).slice(0, 160));
  } catch {
    return scrub(args.slice(0, 160));
  }
}

/** Convert the durable transcript into semantically distinct timeline items. */
export function messagesToTimeline(messages: HermesMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const pendingCalls = new Map<string, { tool: string; args?: string; at?: string }>();
  for (const m of messages) {
    if (m.display_kind === "hidden") continue;
    const id = String(m.id);
    const at = iso(m.timestamp);
    const text = contentText(m.content);
    if (m.role === "user") items.push({ kind: "user", id, text, at });
    else if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) {
        if (call.id) pendingCalls.set(call.id, { tool: call.function?.name ?? "tool", args: call.function?.arguments, at });
      }
      if (text.trim()) items.push({ kind: "assistant", id, text, at, reasoning: m.reasoning ?? undefined });
    } else if (m.role === "tool") {
      const call = m.tool_call_id ? pendingCalls.get(m.tool_call_id) : undefined;
      const tool = m.tool_name ?? call?.tool ?? "tool";
      const detail = scrub(text.slice(0, 500));
      items.push({
        kind: "tool",
        id,
        tool,
        summary: summarizeArgs(call?.args) ?? "",
        detail,
        at,
        error: /^(error|BLOCKED:)/i.test(text.trim()),
      });
    } else if (m.role === "system") {
      if (text.trim()) items.push({ kind: "system", id, text, at });
    }
  }
  return items;
}
