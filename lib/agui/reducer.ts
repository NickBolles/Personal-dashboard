/**
 * Client side of the AG-UI chat stream (Coordinators C1): AG-UI events from
 * server/agui/hermes.ts → the Jarvis `RunEvent`s the chat run reducer
 * (components/chat/useRunStream.ts) already understands. No CopilotKit; types
 * from `@ag-ui/core` only. Keep one `AguiReadState` per run (it survives
 * reconnects, so tool names stay known).
 */
import { EventType, type AGUIEvent } from "@ag-ui/core";
import type { ApprovalRequest, RunEvent } from "@/lib/hermes";

export const AGUI_APPROVAL_TOOL = "hermes_approval";
export const AGUI_STREAM_CLOSED = "jarvis.stream_closed";

export type AguiReadState = { tools: Map<string, string>; pending: Map<string, { args: string; resumed: boolean; at: string }> };
export const newAguiReadState = (): AguiReadState => ({ tools: new Map(), pending: new Map() });

const TERMINAL = ["completed", "failed", "cancelled", "interrupted"] as const;
const CHOICES = ["once", "session", "always", "deny"] as const;

/** Is this parsed SSE payload an AG-UI event (vs. a Jarvis RunEvent)? */
export function isAguiEvent(v: unknown): v is AGUIEvent {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string" && /^[A-Z_]+$/.test((v as { type: string }).type);
}

const iso = (ts: number | undefined) => new Date(ts ?? Date.now()).toISOString();
const parse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export function aguiToRunEvents(e: AGUIEvent, st: AguiReadState): RunEvent[] {
  const at = iso(e.timestamp);
  switch (e.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
      return [{ type: "text.delta", delta: e.delta }];
    case EventType.REASONING_MESSAGE_CONTENT:
      return [{ type: "reasoning", text: e.delta }];
    case EventType.TOOL_CALL_START: {
      const meta = (e.metadata as { jarvis?: { resumed?: boolean; at?: string } } | undefined)?.jarvis;
      st.tools.set(e.toolCallId, e.toolCallName);
      st.pending.set(e.toolCallId, { args: "", resumed: Boolean(meta?.resumed), at: str(meta?.at) ?? at });
      return [];
    }
    case EventType.TOOL_CALL_ARGS: {
      const p = st.pending.get(e.toolCallId);
      if (p) p.args += e.delta;
      return [];
    }
    case EventType.TOOL_CALL_END: {
      // Announce the tool once its (preview) args are complete.
      const name = st.tools.get(e.toolCallId);
      const p = st.pending.get(e.toolCallId);
      st.pending.delete(e.toolCallId);
      if (!name || !p || p.resumed || name === AGUI_APPROVAL_TOOL) return [];
      return [{ type: "tool.started", tool: name, preview: str(parse(p.args).preview), at: p.at }];
    }
    case EventType.TOOL_CALL_RESULT: {
      const name = st.tools.get(e.toolCallId) ?? "tool";
      const c = typeof e.content === "string" ? parse(e.content) : {};
      if (name === AGUI_APPROVAL_TOOL) return [{ type: "approval.resolved", choice: str(c.choice), at }];
      return [{ type: "tool.completed", tool: name, preview: str(c.preview), durationSec: num(c.durationSec), error: c.ok === false, at }];
    }
    case EventType.SUBAGENT_STARTED:
      return [{ type: "subagent.started", id: e.subagentRunId, goal: e.description, at }];
    case EventType.SUBAGENT_FINISHED: {
      const r = (e.result ?? {}) as Record<string, unknown>;
      return [{ type: "subagent.completed", id: e.subagentRunId, goal: str(r.goal), summary: str(r.summary), status: str(r.status), at }];
    }
    case EventType.CUSTOM: {
      const v = (e.value ?? {}) as Record<string, unknown>;
      if (e.name === "jarvis.commentary") return [{ type: "commentary", text: str(v.text) ?? "" }];
      if (e.name === "jarvis.steer_queued") return [{ type: "steer.queued", at }];
      if (e.name === "jarvis.replay_truncated") return [{ type: "replay.truncated", oldestSeq: num(v.oldestSeq) }];
      return [];
    }
    case EventType.RUN_FINISHED: {
      const o = e.outcome;
      if (o?.type === "interrupt") {
        const i = o.interrupts[0];
        const h = ((i?.metadata as { hermes?: Record<string, unknown> } | undefined)?.hermes ?? {}) as Record<string, unknown>;
        const choices = (Array.isArray(h.choices) ? h.choices : []).filter((c): c is ApprovalRequest["choices"][number] =>
          (CHOICES as readonly string[]).includes(c),
        );
        return [
          {
            type: "approval.requested",
            at,
            requestId: str(h.requestId),
            command: str(h.command),
            description: i?.message,
            choices: choices.length ? choices : ["once", "deny"],
          },
        ];
      }
      if (o?.type === "cancelled") return [{ type: "run.terminal", status: "cancelled", at }];
      const r = (e.result ?? {}) as Record<string, unknown>;
      return [{ type: "run.terminal", status: "completed", output: str(r.output), pendingSteer: str(r.pendingSteer), at }];
    }
    case EventType.RUN_ERROR: {
      if (e.code === AGUI_STREAM_CLOSED) return [{ type: "stream.closed", reason: "upstream_closed", message: e.message }];
      const status = e.code?.startsWith("hermes.") ? e.code.slice(7) : "failed";
      const meta = ((e.metadata as { jarvis?: Record<string, unknown> } | undefined)?.jarvis ?? {}) as Record<string, unknown>;
      return [
        {
          type: "run.terminal",
          status: (TERMINAL as readonly string[]).includes(status) ? (status as (typeof TERMINAL)[number]) : "failed",
          error: status === "cancelled" ? undefined : e.message,
          pendingSteer: str(meta.pendingSteer),
          at,
        },
      ];
    }
    default:
      return [];
  }
}
