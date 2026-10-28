/**
 * Hermes → AG-UI 1.0 adapter (Coordinators C1).
 *
 * Input: Jarvis' normalized Hermes run events (`RunEvent`, from
 * integrations/hermes/normalize.ts, already scrubbed). Output: AG-UI events
 * typed with `@ag-ui/core` only (no CopilotKit runtime).
 *
 * Mapping (plan §2.3):
 *   message.delta        → TEXT_MESSAGE_START/CONTENT … END
 *   reasoning.available  → REASONING_START / MESSAGE_START / CONTENT / MESSAGE_END / END
 *   tool.started         → TOOL_CALL_START/ARGS{preview}/END   (synthesised toolCallId: Hermes sends none)
 *   tool.completed       → TOOL_CALL_RESULT{ok,durationSec,preview}  (FIFO per tool name)
 *   subagent.*           → SUBAGENT_STARTED / SUBAGENT_FINISHED
 *   approval.request     → TOOL_CALL(hermes_approval) + RUN_FINISHED{outcome: interrupt}
 *   approval.responded   → (new AG-UI run) RUN_STARTED + TOOL_CALL_RESULT(hermes_approval)
 *   run.completed        → RUN_FINISHED{success}
 *   run.failed/cancelled/interrupted → RUN_ERROR{code: hermes.<status>}
 *   stream closed early  → RUN_ERROR{code: jarvis.stream_closed} (the client reconciles; never "completed")
 *   commentary / steer / replay.truncated → CUSTOM jarvis.*;  unknown → RAW
 *
 * Hermes approvals block *inside* one Hermes run while AG-UI interrupts *end*
 * the AG-UI run, so one Hermes run becomes several AG-UI runs on the same
 * thread: `<hermesRunId>`, then `<hermesRunId>~<seq>` after each interrupt or
 * reconnect. The SSE id stays the Hermes `seq`, so Last-Event-ID resume works.
 */
import { EventType, type AGUIEvent, type Interrupt, type ResumeEntry } from "@ag-ui/core";
import type { ApprovalRequest, RunEvent } from "@/lib/hermes";

/** Hermes `approvals.timeout` default (seconds); its in-run approvals expire after this. */
export const HERMES_APPROVAL_TIMEOUT_S = 300;
export const APPROVAL_TOOL = "hermes_approval";

export type AguiEvent = AGUIEvent;

type Opts = {
  threadId: string;
  hermesRunId: string;
  /** Last Hermes seq the client already has (reconnects start a fresh AG-UI run segment). */
  resumeFromSeq?: number;
  now?: () => number;
};

export class HermesAguiTranslator {
  private readonly threadId: string;
  private readonly hermesRunId: string;
  private readonly now: () => number;
  private runId: string | null = null;
  private segment = 0;
  private textId: string | null = null;
  private openTools = new Map<string, string[]>();
  private openSubagents: { id: string; goal?: string }[] = [];
  private approvalToolCallId: string | null = null;
  private finished = false;
  private lastSeq: number | undefined;

  constructor(o: Opts) {
    this.threadId = o.threadId;
    this.hermesRunId = o.hermesRunId;
    this.now = o.now ?? Date.now;
    this.lastSeq = o.resumeFromSeq;
  }

  /** True once a terminal RUN_FINISHED/RUN_ERROR for the Hermes run has been emitted. */
  get done() {
    return this.finished;
  }

  private ev<T extends AguiEvent>(e: T): T {
    return { timestamp: this.now(), ...e };
  }

  private ensureRun(out: AguiEvent[]) {
    if (this.runId) return;
    const first = this.segment === 0 && this.lastSeq === undefined;
    this.runId = first ? this.hermesRunId : `${this.hermesRunId}~${this.lastSeq ?? 0}${this.segment ? `.${this.segment}` : ""}`;
    this.segment++;
    out.push(
      this.ev({
        type: EventType.RUN_STARTED,
        threadId: this.threadId,
        runId: this.runId,
        ...(first ? {} : { parentRunId: this.hermesRunId }),
        metadata: { jarvis: { hermesRunId: this.hermesRunId } },
      }),
    );
  }

  private endText(out: AguiEvent[]) {
    if (!this.textId) return;
    out.push(this.ev({ type: EventType.TEXT_MESSAGE_END, messageId: this.textId }));
    this.textId = null;
  }

  private endRun(out: AguiEvent[], e: AguiEvent) {
    this.endText(out);
    out.push(e);
    this.runId = null;
  }

  private toolId(seq: number | undefined, kind = "tc") {
    return `${kind}_${this.hermesRunId}_${seq ?? `x${this.now()}`}`;
  }

  /** Translate one normalized Hermes event. */
  push(e: RunEvent): AguiEvent[] {
    const out: AguiEvent[] = [];
    if (this.finished) return out;
    if (e.type === "stream.closed") return this.close(e.message ?? e.reason);
    const seq = "seq" in e ? e.seq : undefined;
    this.ensureRun(out);
    switch (e.type) {
      case "text.delta": {
        if (!e.delta) break;
        if (!this.textId) {
          this.textId = `m_${this.runId}`;
          out.push(this.ev({ type: EventType.TEXT_MESSAGE_START, messageId: this.textId, role: "assistant" }));
        }
        out.push(this.ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: this.textId, delta: e.delta }));
        break;
      }
      case "reasoning": {
        if (!e.text) break;
        const id = `r_${this.hermesRunId}_${seq ?? this.now()}`;
        out.push(
          this.ev({ type: EventType.REASONING_START, messageId: id }),
          this.ev({ type: EventType.REASONING_MESSAGE_START, messageId: id, role: "reasoning" }),
          this.ev({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta: e.text }),
          this.ev({ type: EventType.REASONING_MESSAGE_END, messageId: id }),
          this.ev({ type: EventType.REASONING_END, messageId: id }),
        );
        break;
      }
      case "commentary":
        if (e.text) out.push(this.ev({ type: EventType.CUSTOM, name: "jarvis.commentary", value: { text: e.text } }));
        break;
      case "tool.started": {
        const id = this.toolId(seq);
        const q = this.openTools.get(e.tool) ?? [];
        q.push(id);
        this.openTools.set(e.tool, q);
        this.toolCall(out, id, e.tool, e.preview !== undefined ? { preview: e.preview } : undefined, { at: e.at });
        break;
      }
      case "tool.completed": {
        let id = this.openTools.get(e.tool)?.shift();
        if (!id) {
          // Started before this connection (reconnect) or never announced: open + close it here.
          id = this.toolId(seq);
          this.toolCall(out, id, e.tool, undefined, { at: e.at, resumed: true });
        }
        out.push(
          this.ev({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `res_${id}`,
            toolCallId: id,
            role: "tool",
            content: JSON.stringify({ ok: !e.error, durationSec: e.durationSec ?? null, preview: e.preview ?? null }),
          }),
        );
        break;
      }
      case "subagent.started": {
        const id = e.id ?? this.toolId(seq, "sa");
        this.openSubagents.push({ id, goal: e.goal });
        out.push(this.ev({ type: EventType.SUBAGENT_STARTED, subagentRunId: id, name: "hermes_subagent", ...(e.goal ? { description: e.goal } : {}) }));
        break;
      }
      case "subagent.completed": {
        const idx = this.openSubagents.findIndex((s) => (e.id ? s.id === e.id : s.goal === e.goal));
        const open = idx >= 0 ? this.openSubagents.splice(idx, 1)[0] : undefined;
        const id = open?.id ?? e.id ?? this.toolId(seq, "sa");
        if (!open)
          out.push(this.ev({ type: EventType.SUBAGENT_STARTED, subagentRunId: id, name: "hermes_subagent", ...(e.goal ? { description: e.goal } : {}) }));
        out.push(
          this.ev({
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: id,
            outcome: { type: "success" },
            result: { summary: e.summary ?? null, status: e.status ?? null, goal: e.goal ?? null },
          }),
        );
        break;
      }
      case "approval.requested": {
        const toolCallId = `tc_appr_${e.requestId ?? `${this.hermesRunId}_${seq ?? 0}`}`;
        this.approvalToolCallId = toolCallId;
        this.endText(out);
        this.toolCall(out, toolCallId, APPROVAL_TOOL, { command: e.command ?? null, description: e.description ?? null });
        const interrupt: Interrupt = {
          id: interruptIdFor(e.requestId, this.hermesRunId),
          reason: "tool_call",
          toolCallId,
          message: e.description ?? "Hermes needs approval",
          responseSchema: {
            type: "object",
            properties: { approved: { type: "boolean" }, scope: { enum: e.choices.filter((c) => c !== "deny") } },
            required: ["approved"],
          },
          expiresAt: new Date(this.now() + HERMES_APPROVAL_TIMEOUT_S * 1000).toISOString(),
          metadata: { hermes: { runId: this.hermesRunId, requestId: e.requestId ?? null, command: e.command ?? null, choices: e.choices } },
        };
        this.endRun(
          out,
          this.ev({ type: EventType.RUN_FINISHED, threadId: this.threadId, runId: this.runId!, outcome: { type: "interrupt", interrupts: [interrupt] } }),
        );
        break;
      }
      case "approval.resolved": {
        const id = this.approvalToolCallId ?? (e.requestId ? `tc_appr_${e.requestId}` : null);
        if (id) {
          if (!this.approvalToolCallId) this.toolCall(out, id, APPROVAL_TOOL, undefined, { resumed: true });
          out.push(
            this.ev({
              type: EventType.TOOL_CALL_RESULT,
              messageId: `res_${id}`,
              toolCallId: id,
              role: "tool",
              content: JSON.stringify({ choice: e.choice ?? null }),
            }),
          );
        }
        this.approvalToolCallId = null;
        break;
      }
      case "steer.queued":
        out.push(this.ev({ type: EventType.CUSTOM, name: "jarvis.steer_queued", value: { at: e.at } }));
        break;
      case "replay.truncated":
        out.push(this.ev({ type: EventType.CUSTOM, name: "jarvis.replay_truncated", value: { oldestSeq: e.oldestSeq ?? null } }));
        break;
      case "run.terminal": {
        this.finished = true;
        if (e.status === "completed") {
          this.endRun(
            out,
            this.ev({
              type: EventType.RUN_FINISHED,
              threadId: this.threadId,
              runId: this.runId!,
              outcome: { type: "success" },
              result: { output: e.output ?? null, pendingSteer: e.pendingSteer ?? null },
            }),
          );
        } else {
          this.endRun(
            out,
            this.ev({
              type: EventType.RUN_ERROR,
              code: `hermes.${e.status}`,
              message: e.error ?? `Run ${e.status}`,
              metadata: { jarvis: { status: e.status, pendingSteer: e.pendingSteer ?? null } },
            }),
          );
        }
        break;
      }
      case "unknown":
        out.push(this.ev({ type: EventType.RAW, source: "hermes", event: { event: e.event, seq: e.seq ?? null } }));
        break;
    }
    if (seq !== undefined) this.lastSeq = seq;
    return out;
  }

  private toolCall(out: AguiEvent[], id: string, name: string, args: Record<string, unknown> | undefined, meta?: Record<string, unknown>) {
    out.push(
      this.ev({
        type: EventType.TOOL_CALL_START,
        toolCallId: id,
        toolCallName: name,
        ...(this.textId ? { parentMessageId: this.textId } : {}),
        ...(meta ? { metadata: { jarvis: meta } } : {}),
      }),
    );
    if (args) out.push(this.ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(args) }));
    out.push(this.ev({ type: EventType.TOOL_CALL_END, toolCallId: id }));
  }

  /**
   * The upstream stream ended (or broke) without a terminal event. Never
   * "completed": the client must reconcile with GET /runs/:id and reconnect.
   * After an interrupt nothing is open, so nothing is emitted.
   */
  close(message?: string): AguiEvent[] {
    const out: AguiEvent[] = [];
    if (this.finished) return out;
    if (!this.runId) {
      // Between runs (after an interrupt) the stream closing is not an error.
      if (this.segment > 0) return out;
      this.ensureRun(out);
    }
    this.endRun(out, this.ev({ type: EventType.RUN_ERROR, code: STREAM_CLOSED, message: message || "Stream closed before the run finished" }));
    return out;
  }
}

export const STREAM_CLOSED = "jarvis.stream_closed";

export const interruptIdFor = (requestId: string | undefined, hermesRunId: string) => `int_${requestId ?? hermesRunId}`;

/**
 * An AG-UI resume entry for a Hermes approval interrupt → the Hermes
 * `/v1/runs/:id/approval` choice. Cancelled, unapproved or malformed → deny.
 * The scope must be one Hermes offered; anything else falls back to "once".
 */
export function approvalChoiceFromResume(resume: ResumeEntry, offered: ApprovalRequest["choices"]): ApprovalRequest["choices"][number] {
  if (resume.status !== "resolved") return "deny";
  const p = resume.payload as { approved?: unknown; scope?: unknown } | undefined;
  if (p?.approved !== true) return "deny";
  const scope = typeof p.scope === "string" ? p.scope : "once";
  const allowed = offered.filter((c) => c !== "deny");
  return (allowed as string[]).includes(scope) ? (scope as ApprovalRequest["choices"][number]) : allowed.includes("once") ? "once" : (allowed[0] ?? "deny");
}
