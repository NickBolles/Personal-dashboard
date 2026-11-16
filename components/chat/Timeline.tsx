"use client";

/**
 * The conversation timeline: the owner's messages, the replies, the tool work folded under them, time dividers,
 * the message that is still on its way, and the run in flight (live text, tool steps, an approval or a question
 * waiting on the owner). One renderer for a conversation wherever it is shown; the surface around it owns the
 * scrolling, the header and the composer.
 */

import { createContext, useContext, useState, type ReactNode, type ComponentProps } from "react";
import { isTerminal, type ApprovalRequest, type TimelineItem } from "@/lib/hermes";
import { formatTime } from "@/components/actions/format";
import { Button, cx, useToast } from "@/components/ui";
import { BrainIcon, ForkIcon } from "@/components/icons";
import { ToolStep } from "./ToolStep";
import { needsTimeDivider, unwrapBrokenLines } from "@/lib/chat-text";
import { type Activity, type RunState } from "./useRunStream";
import { AssistantText } from "@/components/smart/AssistantText";
import "./things/things.css";
import { MessageAttachments } from "./Attachments";
import { parseFileMarkers, type ChatFileView } from "@/lib/chat-files";
import { WorkSummary, formatStepSec } from "./WorkSummary";
import { displayRef, splitReferences } from "@/lib/references";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { ClarifyCard } from "@/components/approvals/ClarifyCard";
import { CompactionDivider, NoticeCard } from "./Notice";
import { parseNotice } from "@/lib/chat-notices";
import { RateMessage } from "@/components/feedback/RateMessage";
import { parseUserMessage, sameLabel } from "@/lib/chat/display";
import { ActionsTaken } from "./ActionsTaken";

const CONTEXT_MARK = "\n\n---\nContext from Jarvis:";
import "./timeline.css";

export const NO_FILES: ChatFileView[] = [];
/** Sent attachments of this conversation, for message bubbles. */
export const ChatFiles = createContext<{ sessionId: string; files: ChatFileView[] }>({ sessionId: "", files: NO_FILES });

/** "Hermes" or "Claude": who answers this conversation. */
export const AssistantName = createContext("Hermes");
/** Feedback loop: what each assistant reply's 👍/👎 needs (null on read-only conversations). */
export type RateContext = { sessionId: string; model: string | null; toolsFor: (messageId: string) => string[]; askFix: (prompt: string) => Promise<boolean> };
export const RateCtx = createContext<RateContext | null>(null);

export function Timeline({
  sessionId,
  items,
  replyActions,
  pending,
  live,
  onFork,
}: {
  sessionId: string;
  items: TimelineItem[];
  /** What each reply did, by reply id; "live" is the run in flight. */
  replyActions: Map<string, ComponentProps<typeof ActionsTaken>["actions"]>;
  /** The owner's message that was sent but is not in the transcript yet. */
  pending?: string;
  /** The run in flight, drawn after the transcript. */
  live?: {
    state: RunState;
    onApprove: (c: ApprovalRequest["choices"][number]) => Promise<void> | void;
    onClarify: (answer: string) => Promise<void> | void;
    onRetry: () => void;
  } | null;
  onFork: (item: TimelineItem) => void;
}) {
  const dividerIds = timeDividerIds(items);
  return (
    <>
      <ol className="chat-turns">
        {groupTimeline(items).map((g) => {
          const row = (item: TimelineItem, stepSec?: number) => (
            <TimelineRow
              key={item.id}
              item={item}
              stepSec={stepSec}
              actions={item.kind === "assistant" ? <ActionsTaken actions={replyActions.get(item.id) ?? []} sessionId={sessionId} /> : undefined}
              onFork={() => onFork(item)}
            />
          );
          if (!("tools" in g)) {
            if (g.kind !== "user" && g.kind !== "assistant") return row(g);
            return dividerIds.has(g.id) ? [<TimeDivider key={`t-${g.id}`} at={g.at!} />, row(g)] : row(g);
          }
          return (
            <li key={`work-${g.tools[0].id}`} data-row="work">
              <WorkSummary
                id={g.tools[0].id}
                steps={g.tools}
                seconds={g.seconds}
                alwaysShown={g.tools.flatMap((t, j) => (t.error ? [row(t, g.durations[j])] : []))}
              >
                {g.tools.map((t, j) => row(t, g.durations[j]))}
              </WorkSummary>
            </li>
          );
        })}
        {pending ? (
          <li className="flex flex-col items-end" data-turn="start">
            <SentMessage text={pending} testId="msg-pending" />
          </li>
        ) : null}
      </ol>
      {live ? <LiveRun state={live.state} onApprove={live.onApprove} onClarify={live.onClarify} onRetry={live.onRetry} /> : null}
      <ActionsTaken actions={replyActions.get("live") ?? []} sessionId={sessionId} />
    </>
  );
}

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type TimelineGroup = TimelineItem | { tools: ToolItem[]; seconds?: number; durations: (number | undefined)[] };

function span(from?: string, to?: string): number | undefined {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : undefined;
}

/** Fold each run of consecutive tool rows into one summary group (UI only; data unchanged). */
export function groupTimeline(items: TimelineItem[]): TimelineGroup[] {
  const out: TimelineGroup[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "tool") {
      out.push(it);
      continue;
    }
    const tools: ToolItem[] = [];
    while (i < items.length && items[i].kind === "tool") tools.push(items[i++] as ToolItem);
    const last = tools[tools.length - 1];
    // The turn ends at the assistant reply; without one (stopped turn), at the last tool result — never at a later user message.
    const endAt = items[i]?.kind === "assistant" ? items[i].at : last.at;
    const seconds = span(tools[0].startedAt ?? tools[0].at, endAt);
    // A step runs from its call to its result (`at` is the result time); rows without a call time get no duration.
    const durations = tools.map((t) => span(t.startedAt, t.at));
    out.push({ tools, seconds, durations });
    i--;
  }
  return out;
}

function liveSeconds(activity: Activity[]): number | undefined {
  const starts = activity.map((a) => Date.parse(a.startedAt)).filter(Number.isFinite);
  if (!starts.length) return undefined;
  const first = Math.min(...starts);
  const last = activity.reduce((m, a) => {
    const s = Date.parse(a.startedAt);
    const d = a.kind === "tool" && a.durationSec !== undefined ? a.durationSec * 1000 : 0;
    return Number.isFinite(s) ? Math.max(m, s + d) : m;
  }, first);
  return (last - first) / 1000;
}

/** Message ids that get a centred time divider (first timed message, then gaps over 5 minutes). */
function timeDividerIds(items: TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  let prev: string | undefined;
  for (const t of items) {
    if (t.kind !== "user" && t.kind !== "assistant") continue;
    if (needsTimeDivider(prev, t.at)) ids.add(t.id);
    if (t.at) prev = t.at;
  }
  return ids;
}

function TimeDivider({ at }: { at: string }) {
  return (
    <li className="chat-time-divider" data-dynamic>
      <time dateTime={at}>{formatTime(at)}</time>
    </li>
  );
}

/**
 * Whether the run in flight is drawn after the transcript. A finished run's reply can land in the refetched
 * transcript one render before the live copy is cleared: it is not shown twice in that window.
 */
export function liveRunVisible(state: RunState, active: boolean, timeline: TimelineItem[]): boolean {
  if (!state.runId) return false;
  const liveText = (state.text || state.output || "").trim();
  const lastAssistant = [...timeline].reverse().find((t) => t.kind === "assistant");
  const inTranscript =
    state.phase === "completed" && Boolean(liveText) && Boolean(lastAssistant && "text" in lastAssistant && lastAssistant.text.trim() === liveText);
  return !inTranscript && (active || state.phase !== "completed" || Boolean(state.text) || state.activity.length > 0);
}

/** Tapping a message shows its time and actions; links, buttons, disclosures and text selection keep working. */
function useMetaToggle() {
  const [meta, setMeta] = useState(false);
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a,button,summary,input,textarea,select,[role=button],[role=menuitem]")) return;
    if (window.getSelection()?.toString()) return;
    setMeta((m) => !m);
  };
  return { meta, setMeta, onClick };
}

function TimelineRow({ item, onFork, stepSec, actions }: { item: TimelineItem; onFork: () => void; stepSec?: number; actions?: ReactNode }) {
  const who = useContext(AssistantName);
  const { meta, setMeta, onClick } = useMetaToggle();
  const time = item.at ? formatTime(item.at) : undefined;
  // Hermes control frames (delegation results, process notices, steers, compaction handoffs) arrive as
  // plain message text; render them as what they are, not as something the person typed.
  const notice = item.kind === "tool" ? null : parseNotice(item.text);
  if (notice?.kind === "compaction")
    return (
      <li>
        <CompactionDivider summary={notice.summary} />
      </li>
    );
  if (notice?.kind === "delegation" || notice?.kind === "process")
    return (
      <li>
        <NoticeCard notice={notice} time={time} />
      </li>
    );
  if (notice?.kind === "steer" && item.kind === "user") {
    return (
      <li className="chat-msg group flex flex-col items-end" data-meta={meta || undefined} data-turn="start">
        <SentMessage text={notice.text} caption="Sent while it was working" srPrefix="You said mid-run: " onClick={onClick} />
        <MessageMeta time={time} onFork={onFork} who="your message" text={notice.text} />
      </li>
    );
  }
  if (item.kind === "user") {
    return (
      <li className="chat-msg group flex flex-col items-end" data-meta={meta || undefined} data-turn="start">
        <SentMessage text={item.text} onClick={onClick} onContextMenu={() => setMeta(true)} />
        {/* Copy / fork keep working on the message exactly as it was sent. */}
        <MessageMeta time={time} onFork={onFork} who="your message" text={item.text} />
      </li>
    );
  }
  if (item.kind === "assistant") {
    return (
      <li className="chat-msg flex flex-col" data-meta={meta || undefined} id={`msg-${item.id}`}>
        <div className="min-w-0 max-w-full" data-testid="msg-bubble" data-who="assistant" onClick={onClick} onContextMenu={() => setMeta(true)}>
          <span className="sr-only">{who} said: </span>
          <AssistantText text={item.text} />
        </div>
        {actions}
        <MessageMeta time={time} onFork={onFork} who={`${who}' message`} text={item.text} rateId={item.id} />
      </li>
    );
  }
  if (item.kind === "tool") {
    return (
      <ToolStep
        id={item.id}
        tool={item.tool}
        input={item.input}
        output={item.detail}
        error={item.error}
        duration={stepSec !== undefined ? formatStepSec(stepSec) : undefined}
      />
    );
  }
  return (
    <li className="text-center text-xs text-muted">
      <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">{item.text}</p>
    </li>
  );
}

const USER_BUBBLE = "tl-user-bubble px-3 py-1.5 sm:py-2";

/**
 * A message the person sent, shown as they meant it (lib/chat/display `parseUserMessage`; the stored text is untouched):
 * the "[Viewing: Today — /home]" page context becomes a quiet caption above the bubble, and a one-tap decision
 * answer becomes a compact receipt (answer first, the question behind a disclosure) instead of a typed paragraph.
 */
function SentMessage({
  text,
  caption,
  srPrefix = "You said: ",
  testId = "msg-bubble",
  onClick,
  onContextMenu,
}: {
  text: string;
  /** the just-sent copy shown until the transcript has the message is not a transcript bubble */
  testId?: string;
  /** e.g. "Sent while it was working" */
  caption?: string;
  srPrefix?: string;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: () => void;
}) {
  const at = text.indexOf(CONTEXT_MARK);
  const parts = parseUserMessage(at >= 0 ? text.slice(0, at) : text);
  const ctx = at >= 0 ? text.slice(at + CONTEXT_MARK.length).trim() : "";
  const d = parts.decision;
  return (
    <>
      {caption ? <span className="chat-msg-caption">{caption}</span> : null}
      {parts.context ? (
        <span className="chat-msg-caption" data-testid="msg-context" title={parts.context.path}>
          <span className="sr-only">Sent while </span>
          <span className="truncate">Viewing: {parts.context.label}</span>
        </span>
      ) : null}
      <div
        className={cx(USER_BUBBLE, d ? "chat-receipt" : "bg-s3")}
        data-testid={testId}
        data-who="user"
        data-receipt={d ? "decision" : undefined}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {d ? (
          <>
            <p className="text-xs break-words text-muted">You decided · {d.title}</p>
            <p className="font-medium break-words select-text">{d.answer}</p>
            {sameLabel(d.title, d.question) ? null : (
              <details className="text-xs text-muted">
                <summary>Question</summary>
                <p className="pb-1 break-words whitespace-pre-wrap select-text">{d.question}</p>
              </details>
            )}
          </>
        ) : (
          <>
            <span className="sr-only">{srPrefix}</span>
            <UserText body={parts.text} ctx={ctx} />
          </>
        )}
      </div>
    </>
  );
}

/**
 * The typed part of a sent message: reference tokens render as chips; the context Jarvis
 * attached (snapshots of references and sources) folds into a disclosure.
 */
function UserText({ body, ctx }: { body: string; ctx: string }) {
  const fileIds = parseFileMarkers(ctx);
  const chatFiles = useContext(ChatFiles);
  return (
    <>
      <p className="[overflow-wrap:anywhere] whitespace-pre-wrap select-text">
        {splitReferences(unwrapBrokenLines(body)).map((p, i) =>
          "ref" in p ? (
            <span key={i} className="chip mx-0.5" data-tone="accent" data-ref={`${p.ref.type}:${p.ref.id}`}>
              {displayRef(p.ref)}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </p>
      {ctx ? (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer">Context Jarvis attached</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{ctx}</pre>
        </details>
      ) : null}
      {fileIds.length ? <MessageAttachments sessionId={chatFiles.sessionId} ids={fileIds} files={chatFiles.files} /> : null}
    </>
  );
}

function MessageMeta({ time, onFork, who, text, rateId }: { time?: string; onFork: () => void; who: string; text: string; rateId?: string }) {
  const isHermes = useContext(AssistantName) === "Hermes";
  const rate = useContext(RateCtx);
  const { toast } = useToast();
  const at = text.indexOf(CONTEXT_MARK);
  const body = at >= 0 ? text.slice(0, at).trim() : text;
  return (
    <div className="msg-meta flex flex-wrap items-center gap-0.5 text-xs text-muted" data-testid="msg-meta">
      {time ? (
        <span className="px-1" data-dynamic>
          {time}
        </span>
      ) : null}
      <Button className="tl-meta-btn" onClick={() => navigator.clipboard?.writeText(body).then(() => toast("Copied", "ok"))} aria-label={`Copy ${who}`}>
        Copy
      </Button>
      {rateId && rate ? (
        <RateMessage
          sessionId={rate.sessionId}
          messageId={rateId}
          surface="chat"
          text={body}
          who={who}
          model={rate.model}
          tools={rate.toolsFor(rateId)}
          onAskFix={rate.askFix}
        />
      ) : null}
      <Button
        className="tl-meta-btn"
        onClick={onFork}
        aria-label={`${isHermes ? "Restart with text through" : "Fork from"} ${who}${time ? ` at ${time}` : ""}`}
      >
        <ForkIcon className="h-3.5 w-3.5" /> {isHermes ? "Restart with text" : "Fork from here"}
      </Button>
    </div>
  );
}

function ActivityRow({ a }: { a: Activity }) {
  const [open, setOpen] = useState(false);
  if (a.kind === "commentary") return <li className="text-sm italic text-muted">{a.text}</li>;
  if (a.kind === "tool") return <ToolStep id={a.callId ?? a.id} tool={a.tool} input={a.preview} output={a.result} done={a.done} error={a.error} />;
  const label = `Subagent${a.goal ? `: ${a.goal}` : ""}${a.summary ? ` — ${a.summary}` : ""}`;
  const status = !a.done ? "running" : (a.status ?? "returned");
  return (
    <li>
      <Button aria-expanded={open} onClick={() => setOpen((o) => !o)} className="chat-tool tl-step">
        <BrainIcon className="h-4 w-4 shrink-0" />
        <span className={cx("min-w-0 flex-1 break-words", status === "running" && "chat-work-shimmer")}>{label}</span>
        <span className={cx("shrink-0 text-xs", status === "failed" && "text-danger")}>{status}</span>
      </Button>
      {open && a.summary ? <p className="ml-5 text-xs">{a.summary}</p> : null}
    </li>
  );
}

export function LiveRun({
  state,
  onApprove,
  onClarify,
  onRetry,
}: {
  state: RunState;
  onApprove: (c: ApprovalRequest["choices"][number]) => Promise<void> | void;
  onClarify: (answer: string) => Promise<void> | void;
  onRetry: () => void;
}) {
  const who = useContext(AssistantName);
  const text = state.text || (isTerminal(state.phase) ? (state.output ?? "") : "");
  return (
    <section aria-label="Current run" className="space-y-2">
      {state.activity.length ? (
        <WorkSummary
          id={`live-${state.runId ?? "run"}`}
          steps={state.activity}
          live={!isTerminal(state.phase)}
          waiting={state.phase === "waiting_for_approval" ? "approval" : state.clarify ? "answer" : undefined}
          seconds={liveSeconds(state.activity)}
          defaultOpen={!text && !isTerminal(state.phase)}
          alwaysShown={state.activity
            .filter((a) => a.kind === "tool" && a.error)
            .map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
        >
          {state.activity.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </WorkSummary>
      ) : null}

      {state.approval ? <ApprovalCard approval={state.approval} agent={who} onAnswer={onApprove} /> : null}
      {state.clarify && !isTerminal(state.phase) ? (
        <ClarifyCard key={state.clarify.requestId} clarify={state.clarify} agent={who} onAnswer={onClarify} />
      ) : null}

      {state.phase === "queued" ? (
        <p role="status" className="text-sm text-muted">
          {state.queueReason === "connections"
            ? "Queued — your message was sent. Jarvis is waiting for a free Hermes connection and shows the reply as soon as one opens."
            : "Queued — waiting for an available agent slot. You can leave this chat; the server will start it automatically."}
        </p>
      ) : null}
      {text || (!isTerminal(state.phase) && state.phase !== "waiting_for_approval" && state.phase !== "queued") ? (
        <div className="min-w-0 max-w-full" data-streaming={!isTerminal(state.phase) || undefined}>
          <span className="sr-only">{who} is saying: </span>
          {text ? <AssistantText text={text} live={!isTerminal(state.phase)} /> : null}
          {!isTerminal(state.phase) && state.phase !== "waiting_for_approval" && state.phase !== "queued" ? (
            <span className="chat-caret" aria-hidden="true" />
          ) : null}
        </div>
      ) : null}

      {state.steerQueued > 0 && !isTerminal(state.phase) ? (
        <p className="text-xs text-muted">Guidance queued ({state.steerQueued}) — Hermes will pick it up at the next step.</p>
      ) : null}
      {state.pendingSteer ? <p className="text-xs text-warn">Not consumed before the run ended: “{state.pendingSteer}”</p> : null}
      {state.phase === "failed" || state.phase === "interrupted" ? (
        <p role="alert" className="text-sm text-danger">
          {state.phase === "failed" ? "The run failed" : "The run was interrupted"}
          {state.error ? `: ${state.error}` : "."}
        </p>
      ) : null}
      {state.phase === "cancelled" ? <p className="text-sm text-muted">Stopped at your request.</p> : null}
      {state.phase === "reconnecting" ? (
        <p role="status" className="text-sm text-warn">
          Connection dropped — reconnecting and checking {who} for the real status…
        </p>
      ) : null}
      {state.phase === "disconnected" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <span>{state.error ?? `Disconnected from ${who}.`} The run may still be going.</span>
          <Button size="sm" onClick={onRetry}>
            Reconnect
          </Button>
        </div>
      ) : null}
    </section>
  );
}
