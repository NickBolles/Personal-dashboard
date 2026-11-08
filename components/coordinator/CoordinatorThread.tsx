"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { AgentResolution } from "@/lib/agents";
import { maskedNotice, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { Markdown } from "@/components/markdown/Markdown";
import { RateMessage } from "@/components/feedback/RateMessage";
import { Button, Dot, Input, cx, useToast, type KTone } from "@/components/ui";
import { inputCls } from "@/components/ui/legacy";
import { composerKey, isSendShortcut } from "@/lib/client/composer-keys";
import { withPageContext, type PageContext } from "@/lib/coordinator/page-context";
import { COORDINATOR_PROMPT, type QuickActionContext } from "@/lib/quick-actions";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { ProposedQuickActions } from "@/components/quick-actions/ProposedQuickActions";
import { useQuickActions } from "@/components/quick-actions/useQuickActions";
import { ActionsTaken } from "@/components/chat/ActionsTaken";
import { actionsByReply } from "@/lib/chat/actions";
import { canControl, steerText, stopText } from "@/lib/coordinator/control";
import { isActiveExec, type ChatExecutionResponse, type ExecutionRecord } from "@/lib/chat-execution";
import type { ConversationListResponse } from "@/lib/work";
import { relativeTime } from "@/lib/time";
import "@/components/agents/agents.css";

export type CoordinatorResponse = {
  area: { id: string; title: string };
  agent: AgentResolution;
  sessionId: string | null;
  sessionTitle: string | null;
  excluded: boolean;
  prompt: string | null;
  lastRunAt: string | null;
};
type Detail = { session: SessionSummary; timeline: TimelineItem[] };

/** Shared thread + send mutation. Area variant preserves its labels, testids and composer. */
export function CoordinatorThread({
  info: d,
  compact = false,
  context = null,
  onRemoveContext,
  draft,
  onDraft,
  inlineActions,
  quickContext,
}: {
  info: CoordinatorResponse;
  compact?: boolean;
  context?: PageContext | null;
  onRemoveContext?: () => void;
  draft?: string;
  onDraft?: (text: string) => void;
  inlineActions?: (lastUserAt: string | null) => ReactNode;
  /** Context for quick-action chips ({area}/{page} fill + scope). Chips fill the composer only. */
  quickContext?: QuickActionContext;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const titleId = useId();
  const [localText, setLocalText] = useState("");
  const text = draft ?? localText;
  const setText = onDraft ?? setLocalText;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!compact) textarea.current?.focus();
  }, [compact]);
  const sid = fresh ? null : (sessionId ?? d.sessionId);
  const pathname = usePathname();
  const quickActions = useQuickActions(!d.excluded);
  const hasProposals = !!quickActions.data?.actions.some((a) => a.status === "proposed");
  const fill = (value: string) => {
    setText(value.slice(0, 8000));
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const fillRef = useRef(fill);
  useEffect(() => {
    fillRef.current = fill;
  });
  useEffect(() => {
    // The area pane takes ⌘K quick actions while it is open; the global rail/sheet handles them otherwise.
    if (compact || d.excluded) return;
    const onPrompt = (e: Event) => {
      const value = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof value === "string") fillRef.current(value);
    };
    window.addEventListener(COORDINATOR_PROMPT, onPrompt);
    return () => window.removeEventListener(COORDINATOR_PROMPT, onPrompt);
  }, [compact, d.excluded]);
  const detail = useQuery({
    queryKey: ["session", sid],
    queryFn: () => api.get<Detail>(`/api/hermes/sessions/${encodeURIComponent(sid!)}`),
    enabled: !!sid && !d.excluded,
    refetchInterval: (q) => (q.state.data?.session?.activeRun ? 3000 : false),
  });
  const execution = useQuery({
    queryKey: ["session-exec", sid],
    queryFn: () => api.get<ChatExecutionResponse>(`/api/hermes/sessions/${encodeURIComponent(sid!)}/execution`),
    enabled: !!sid && !d.excluded,
    refetchInterval: (q) => (detail.data?.session.activeRun || q.state.data?.records?.some(isActiveExec) ? 5000 : 30000),
  });
  const discussions = useQuery({
    queryKey: ["work", "conversations", "coordinator-earlier", d.area.id],
    queryFn: () => api.get<ConversationListResponse>(`/api/work/conversations?view=all&areaId=${encodeURIComponent(d.area.id)}`),
    enabled: earlier && !d.excluded,
  });
  const postInput = (target: string, input: string, control = false): Promise<{ masked?: string[] } | null> => {
    const active = detail.data?.session.activeRun;
    if (control && active) return api.post<{ masked?: string[] } | null>(`/api/hermes/runs/${encodeURIComponent(active.runId)}/steer`, { input });
    return api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(target)}/runs`, {
      input,
      idempotencyKey: newIdempotencyKey(control ? "ctl" : "coord"),
      capabilities: [SMART_CAPABILITY],
    });
  };
  const send = useMutation({
    mutationFn: async ({ input, correction = false }: { input: string; correction?: boolean }) => {
      let target = sid;
      if (!target) {
        const s = await api.post<SessionSummary>("/api/hermes/sessions", { title: `${d.area.title} coordinator`, areaId: d.area.id });
        target = s.id;
        setSessionId(s.id);
        setFresh(false);
      }
      const run = await postInput(target, compact && !correction ? withPageContext(input, context) : input);
      return { target, notice: maskedNotice(run) };
    },
    onSuccess: ({ target, notice }, { correction }) => {
      if (!correction) {
        setText("");
        if (textarea.current && compact) textarea.current.style.height = "auto";
      }
      toast(notice ?? "Sent to the coordinator", notice ? "warn" : undefined);
      void qc.invalidateQueries({ queryKey: ["session", target] });
      void qc.invalidateQueries({ queryKey: ["work", "coordinator"] });
      void refreshSessionLists(qc).catch(() => undefined);
    },
    onError: (err) => toast(`Not sent: ${(err as Error).message}`, "danger"),
  });
  const control = useMutation({
    mutationFn: async (input: string) => {
      if (!sid) throw new Error("No coordinator conversation");
      return maskedNotice(await postInput(sid, input, true));
    },
    onSuccess: (notice) => {
      if (notice) toast(notice, "warn");
      else toast("Sent to the coordinator");
      void qc.invalidateQueries({ queryKey: ["session", sid] });
      void qc.invalidateQueries({ queryKey: ["session-exec", sid] });
      void refreshSessionLists(qc).catch(() => undefined);
    },
    onError: (err) => toast(`Not sent: ${(err as Error).message}`, "danger"),
  });
  const stop = useMutation({
    mutationFn: async () => {
      const runId = detail.data?.session.activeRun?.runId;
      if (!runId) throw new Error("No active coordinator run");
      await api.post(`/api/hermes/runs/${encodeURIComponent(runId)}/stop`);
    },
    onSuccess: () => {
      toast("Stop requested");
      void qc.invalidateQueries({ queryKey: ["session", sid] });
      void qc.invalidateQueries({ queryKey: ["session-exec", sid] });
    },
    onError: (err) => toast(`Not stopped: ${(err as Error).message}`, "danger"),
  });
  const submit = () => {
    if (text.trim() && !send.isPending && !d.excluded) send.mutate({ input: text.trim() });
  };
  const timeline = detail.data?.timeline ?? [];
  const replyActions = useMemo(
    () => new Map(actionsByReply(detail.data?.timeline ?? []).map((group) => [group.replyId, group.actions])),
    [detail.data?.timeline],
  );
  const records = execution.data?.records?.filter((r) => r.source === "subagent" || r.source === "registered_run" || r.source === "jarvis_run") ?? [];
  const previous = discussions.data?.conversations?.filter((c) => c.placement?.parentId === d.area.id && c.id !== sid).slice(0, 5) ?? [];
  const msgs = timeline.filter((t): t is Extract<TimelineItem, { kind: "user" | "assistant" }> => t.kind === "user" || t.kind === "assistant").slice(-6);
  const lastUser = timeline.filter((t) => t.kind === "user").at(-1);
  return (
    <>
      <div className={compact ? "gc-thread-body" : "co-body"} data-testid={compact ? "gc-thread-body" : "coordinator-body"} tabIndex={0}>
        {d.excluded ? (
          <p className="text-sm" data-testid="coordinator-excluded">
            Areas excluded from AI are never sent: this area has no coordinator chat.
          </p>
        ) : (
          <>
            <details className="mb-2 text-xs" onToggle={(event) => setEarlier(event.currentTarget.open)}>
              <summary className="min-h-6 cursor-pointer text-muted">Earlier</summary>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={send.isPending || control.isPending}
                  onClick={() => {
                    setSessionId(null);
                    setFresh(true);
                    requestAnimationFrame(() => textarea.current?.focus());
                  }}
                >
                  New
                </Button>
                {discussions.isLoading ? <span className="text-muted">Loading discussions…</span> : null}
                {discussions.error ? <span role="alert">Couldn&apos;t load earlier discussions.</span> : null}
                {discussions.isSuccess && !previous.length ? <span className="text-muted">No earlier discussions.</span> : null}
              </div>
              <ul>
                {previous.map((c) => (
                  <li key={c.id}>
                    <Link className="inline-flex min-h-11 max-w-full items-center text-accent sm:min-h-10" href={`/chat/${encodeURIComponent(c.id)}`}>
                      <span className="truncate">{c.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
            {!sid ? (
              <div>
                <p className="text-sm text-muted" data-testid={compact ? "gc-empty" : "coordinator-empty"}>
                  No coordinator conversation yet. Your first message starts one, filed in this area.
                </p>
              </div>
            ) : null}
            {detail.isLoading ? <p className="text-sm text-muted">Loading messages…</p> : null}
            {detail.error ? (
              <p role="alert" className="text-sm text-danger">
                Couldn&apos;t load messages: {(detail.error as Error).message}
              </p>
            ) : null}
            {sid && msgs.length ? (
              <ol aria-label="Latest messages">
                {msgs.map((m) => (
                  <li key={m.id} className="co-msg">
                    {m.kind === "assistant" && sid ? (
                      <div className="co-msg-head flex items-center justify-between gap-1">
                        <p className="text-xs font-semibold text-muted">Coordinator</p>
                        <span className="flex shrink-0 items-center" data-testid="coordinator-rate">
                          <RateMessage
                            sessionId={sid}
                            messageId={m.id}
                            surface="coordinator"
                            text={m.text}
                            who="the coordinator's message"
                            model={detail.data?.session.model ?? null}
                            onAskFix={async (prompt) => {
                              if (send.isPending || detail.data?.session.activeRun) {
                                toast("Wait for the coordinator to finish, then ask again.", "warn");
                                return false;
                              }
                              await send.mutateAsync({ input: prompt, correction: true });
                              return true;
                            }}
                          />
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs font-semibold text-muted">{m.kind === "user" ? "You" : "Coordinator"}</p>
                    )}
                    {m.kind === "assistant" ? (
                      <>
                        <Markdown text={m.text} />
                        <ActionsTaken actions={replyActions.get(m.id) ?? []} sessionId={sid ?? undefined} areaHint={d.area.title} compact />
                      </>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text}</p>
                    )}
                  </li>
                ))}
              </ol>
            ) : sid && detail.isSuccess ? (
              <p className="text-sm text-muted">No messages yet.</p>
            ) : null}
            {detail.data?.session?.activeRun ? (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                <Dot tone="ai" live label="Coordinator running" />
                <span className="text-muted">Working…</span>
                <Button size="sm" variant="ghost" loading={stop.isPending} onClick={() => stop.mutate()}>
                  Stop
                </Button>
                <Link className="inline-flex min-h-11 items-center px-2 text-accent sm:min-h-10" href={`/chat/${encodeURIComponent(sid!)}`}>
                  Open
                </Link>
              </div>
            ) : null}
            <ActionsTaken actions={replyActions.get("live") ?? []} sessionId={sid ?? undefined} areaHint={d.area.title} compact />
            {execution.error ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                Couldn&apos;t load coordinator runs.
              </p>
            ) : null}
            {execution.data?.sources?.some((source) => source.state !== "ok") ? (
              <p className="mt-2 text-xs text-muted">Some run sources are unavailable or stale. Open the conversation for details.</p>
            ) : null}
            {records.length ? (
              <section aria-label="Coordinator runs" className="mt-2 space-y-1">
                {records.slice(0, 5).map((record) => (
                  <CoordinatorRunCard
                    key={`${sid}:${record.key}`}
                    record={record}
                    pending={control.isPending}
                    onControl={(input) => control.mutateAsync(input)}
                  />
                ))}
                {records.length > 5 && sid ? (
                  <Link href={`/chat/${encodeURIComponent(sid)}?panel=running`} className="inline-flex min-h-11 items-center text-xs text-accent sm:min-h-10">
                    {records.length - 5} more
                  </Link>
                ) : null}
              </section>
            ) : null}
            {sid ? (
              <Link href={`/chat/${encodeURIComponent(sid)}`} className="mt-2 inline-block text-xs text-accent hover:underline">
                Open full conversation
              </Link>
            ) : null}
            {!sid || detail.isSuccess ? inlineActions?.(lastUser?.at ?? null) : null}
            {/* Rail/sheet: proposals scroll with the thread so the composer keeps its room on short phones. */}
            {compact ? <ProposedQuickActions /> : null}
          </>
        )}
      </div>
      {!d.excluded && !compact ? <ProposedQuickActions /> : null}
      {!d.excluded ? (
        <form
          className={compact ? "gc-composer" : "co-foot"}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {compact && context ? (
            <div className="gc-context">
              <span>Viewing: {context.label}</span>
              <button type="button" aria-label="Remove page context" onClick={onRemoveContext}>
                ×
              </button>
            </div>
          ) : null}
          <QuickActionChips variant="row" context={quickContext ?? { areaId: d.area.id, areaTitle: d.area.title, path: pathname }} onPrompt={fill} />
          <label htmlFor={`${titleId}-m`} className="sr-only">
            Message the coordinator
          </label>
          <div className={compact ? "gc-compose-row" : undefined}>
            <textarea
              ref={textarea}
              id={`${titleId}-m`}
              data-autofocus
              data-testid={compact ? "gc-input" : "coordinator-input"}
              className={compact ? "gc-input" : cx(inputCls, "min-h-[72px] w-full min-w-0 resize-y text-[16px] sm:text-sm")}
              rows={compact ? 1 : text.length > 200 ? 8 : 3}
              maxLength={8000}
              value={text}
              placeholder="Ask the coordinator…"
              onChange={(e) => {
                setText(e.target.value);
                if (compact) {
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }
              }}
              onKeyDown={(e) => {
                if (isSendShortcut(composerKey(e))) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {compact ? (
              <Button
                type="submit"
                variant="primary"
                size="sm"
                iconOnly
                icon={<span>↑</span>}
                className="gc-send"
                aria-label="Send"
                disabled={!text.trim()}
                loading={send.isPending}
              >
                Send
              </Button>
            ) : null}
          </div>
          {!compact ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!d.prompt}
                onClick={() => d.prompt && setText(d.prompt)}
                data-testid="coordinator-catch-up"
                title="Fills the message with a summary of this area's open items, decisions and recent activity. Nothing is sent until you tap Send."
              >
                Catch me up
              </Button>
              <span className="min-w-0 flex-1 text-xs text-muted">{text ? "Review, then tap Send." : null}</span>
              <Button
                type="submit"
                size="sm"
                variant={hasProposals ? "secondary" : "primary"}
                disabled={!text.trim()}
                loading={send.isPending}
                data-testid="coordinator-send"
              >
                Send
              </Button>
            </div>
          ) : (
            <p className="gc-hint">Ctrl/⌘+Enter to send · Enter for a new line</p>
          )}
        </form>
      ) : null}
    </>
  );
}

const RUN_TONE: Record<ExecutionRecord["state"], KTone> = {
  running: "ai",
  waiting: "wn",
  completed: "ok",
  failed: "bad",
  cancelled: "neutral",
  unknown: "neutral",
};

function CoordinatorRunCard({ record, pending, onControl }: { record: ExecutionRecord; pending: boolean; onControl: (input: string) => Promise<unknown> }) {
  const [steering, setSteering] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  // A child discovered through the session list first keeps its child-session id as record id;
  // the coordinator steers/stops by Hermes' sub-agent handle (#251).
  const handle = record.subagentId ?? record.id;
  const controllable = record.source === "subagent" && canControl(handle) && isActiveExec(record);
  const at = record.updatedAt ?? record.endedAt ?? record.startedAt;
  return (
    <article className="min-w-0 rounded-lg border border-line px-2 py-1" data-testid="coordinator-run-card" aria-label={record.title}>
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
        <Dot tone={RUN_TONE[record.state]} live={record.state === "running"} label={record.state} />
        <span className="min-w-0 flex-1 truncate" title={record.title}>
          {record.title}
        </span>
        {at ? (
          <time dateTime={at} title={at} className="text-muted" data-dynamic>
            {relativeTime(at)}
          </time>
        ) : null}
        {record.href ? (
          <Link className="inline-flex min-h-11 items-center px-2 text-accent sm:min-h-10" href={record.href}>
            Open
          </Link>
        ) : null}
        {controllable ? (
          <>
            <Button size="sm" variant="ghost" disabled={pending} aria-expanded={steering} onClick={() => setSteering((value) => !value)}>
              Steer
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmStop((value) => !value)}>
              {confirmStop ? "Cancel stop" : "Stop"}
            </Button>
            {confirmStop ? (
              <Button
                size="sm"
                variant="danger"
                loading={pending}
                onClick={() =>
                  void onControl(stopText(handle))
                    .then(() => setConfirmStop(false))
                    .catch(() => undefined)
                }
              >
                Stop? Yes
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {controllable && steering ? (
        <form
          className="mt-1 flex min-w-0 flex-wrap items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!guidance.trim() || pending) return;
            void onControl(steerText(handle, guidance))
              .then(() => {
                setGuidance("");
                setSteering(false);
              })
              .catch(() => undefined);
          }}
        >
          <Input
            aria-label={`Guidance for ${record.title}`}
            className="min-w-0 flex-1"
            value={guidance}
            maxLength={2000}
            onChange={(event) => setGuidance(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!guidance.trim()} loading={pending}>
            Send
          </Button>
        </form>
      ) : null}
    </article>
  );
}
