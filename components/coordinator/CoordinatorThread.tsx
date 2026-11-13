"use client";

import Link from "next/link";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { AgentResolution } from "@/lib/agents";
import { maskedNotice, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { Markdown } from "@/components/markdown/Markdown";
import { AssistantText, SmartSession } from "@/components/smart/AssistantText";
import {
  AttachButton,
  AttachmentChips,
  CameraButton,
  MessageAttachments,
  pastedFiles,
  useChatAttachments,
  useConversationFiles,
} from "@/components/chat/Attachments";
import { ContextSheet, type ContextChip } from "@/components/chat/ContextSheet";
import { parseFileMarkers } from "@/lib/chat-files";
import { AlertIcon, BellIcon, BoltIcon, CheckIcon, ClockIcon, InboxIcon, PlusIcon } from "@/components/icons";
import { RateMessage } from "@/components/feedback/RateMessage";
import { Button, ChipButton, Dot, Menu, Textarea, useOnline, useToast } from "@/components/ui";
import { scopeChip, scopeIsCommand, scopeLabel, scopeMessage, scopePlaceholder, scopeSendsEmpty, type ComposeScope } from "@/lib/coordinator/compose";
import { parseNotice } from "@/lib/chat-notices";
import { refChips, sinceDivider } from "@/lib/coordinator/runs-view";
import { composerKey, isSendShortcut } from "@/lib/client/composer-keys";
import { withPageContext, type PageContext } from "@/lib/coordinator/page-context";
import { COORDINATOR_PROMPT, type QuickActionContext } from "@/lib/quick-actions";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { ProposedQuickActions } from "@/components/quick-actions/ProposedQuickActions";
import { useQuickActions } from "@/components/quick-actions/useQuickActions";
import { ActionsTaken } from "@/components/chat/ActionsTaken";
import { actionsByReply } from "@/lib/chat/actions";
import { isActiveExec, type ChatExecutionResponse, type ExecutionRecord } from "@/lib/chat-execution";
import { mergeBackgroundWork, placeWork, sinceChips, workKey, type BackgroundWork, type SinceChip, type SinceCounts } from "@/lib/coordinator/run-card";
import { ExecCard, LiveLine } from "@/components/coordinator/running/RunCard";
import { useCoordinatorRuns } from "@/components/coordinator/running/useCoordinatorRuns";
import type { ConversationListResponse } from "@/lib/work";
import { parseUserMessage, splitAttachedContext } from "@/lib/chat/display";
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
  name = "Coordinator",
  context = null,
  contextRemoved = false,
  onRemoveContext,
  onRestoreContext,
  onAskPage,
  draft,
  onDraft,
  inlineActions,
  quickContext,
  lastLookedChat,
  sinceCounts = { decisions: 0, runs: 0 },
  onJump,
  onRef,
  commandRef,
  scope: scopeProp,
  onScope,
}: {
  /**
   * What the next message is about (the chip in the composer): set by Steer, Reply, Retry or "ask about this" on
   * a row here or in another tab. Controlled by the host when it passes `onScope`; kept here otherwise.
   */
  scope?: ComposeScope | null;
  onScope?: (scope: ComposeScope | null) => void;
  info: CoordinatorResponse;
  compact?: boolean;
  /** Who the owner is talking to, as shown on replies ("Chief of staff" in the global rail). */
  name?: string;
  context?: PageContext | null;
  /** The owner turned this page's context off (it can be shared again). */
  contextRemoved?: boolean;
  onRemoveContext?: () => void;
  onRestoreContext?: () => void;
  /** Fills the composer with a question about the page being viewed. Never sends. */
  onAskPage?: () => void;
  draft?: string;
  onDraft?: (text: string) => void;
  inlineActions?: (lastUserAt: string | null) => ReactNode;
  /** Context for quick-action chips ({area}/{page} fill + scope). Chips fill the composer only. */
  quickContext?: QuickActionContext;
  lastLookedChat?: string | null;
  sinceCounts?: SinceCounts;
  /** A catch-up chip was tapped: the tab it points at, and which chip (so the tab can land on that part). */
  onJump?: (tab: "needs" | "running", about?: string) => void;
  onRef?: (ref: string) => void;
  /**
   * Lets another panel (a run card under Activity) send a one-line command into this conversation, exactly as the
   * background-work cards here do. Null while there is no conversation to send it to.
   */
  commandRef?: { current: ((text: string) => Promise<unknown>) | null };
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const titleId = useId();
  const online = useOnline();
  const sentText = compact ? `Sent to your ${name}` : "Sent to the coordinator";
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
  const [localScope, setLocalScope] = useState<ComposeScope | null>(null);
  const scope = onScope ? (scopeProp ?? null) : localScope;
  const setScope = onScope ?? setLocalScope;
  // One composer: a row's Steer / Reply / Retry puts its chip here and hands over the keyboard.
  const compose = (next: ComposeScope) => {
    setScope(next);
    requestAnimationFrame(() => textarea.current?.focus());
  };
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
    refetchInterval: (q) => (detail.data?.session?.activeRun || q.state.data?.records?.some(isActiveExec) ? 5000 : 15000),
  });
  const discussions = useQuery({
    queryKey: ["work", "conversations", "coordinator-earlier", d.area.id],
    queryFn: () => api.get<ConversationListResponse>(`/api/work/conversations?view=all&areaId=${encodeURIComponent(d.area.id)}`),
    enabled: earlier && !d.excluded,
  });
  const postInput = (
    target: string,
    input: string,
    control = false,
    extra: { context?: string; files?: string[] } = {},
  ): Promise<{ masked?: string[] } | null> => {
    const active = detail.data?.session?.activeRun;
    if (control && active) return api.post<{ masked?: string[] } | null>(`/api/hermes/runs/${encodeURIComponent(active.runId)}/steer`, { input });
    return api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(target)}/runs`, {
      input,
      idempotencyKey: newIdempotencyKey(control ? "ctl" : "coord"),
      capabilities: [SMART_CAPABILITY],
      ...extra,
    });
  };
  // One conversation per thread: the first attachment and Send can both ask for it before it exists, so they
  // share the request in flight (two requests made two conversations, the file in one and the message in the other).
  const creating = useRef<Promise<string> | null>(null);
  useEffect(() => {
    if (sid) creating.current = null;
  }, [sid]);
  const ensureSession = (): Promise<string> => {
    if (sid) return Promise.resolve(sid);
    creating.current ??= api
      .post<SessionSummary>("/api/hermes/sessions", { title: `${d.area.title} coordinator`, areaId: d.area.id })
      .then((s) => {
        setSessionId(s.id);
        setFresh(false);
        return s.id;
      })
      .catch((err: unknown) => {
        creating.current = null;
        throw err;
      });
    return creating.current;
  };
  // Same attach + context tools as the full chat composer. Files upload to the conversation, so the first
  // attachment starts it (nothing is sent to the agent until Send).
  // An area excluded from AI has no conversation here: nothing is fetched or uploaded for it.
  const attachments = useChatAttachments(d.excluded ? "" : (sid ?? ""));
  const queued = useRef<File[]>([]);
  const addFiles = attachments.add;
  useEffect(() => {
    if (!sid || !queued.current.length) return;
    const files = queued.current;
    queued.current = [];
    addFiles(files);
  }, [sid, addFiles]);
  const attach = (files: File[]) => {
    if (!files.length || d.excluded) return;
    if (sid) return attachments.add(files);
    queued.current.push(...files);
    void ensureSession().catch((err) => {
      queued.current = [];
      toast(`Not attached: ${(err as Error).message}`, "danger");
    });
  };
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const send = useMutation({
    mutationFn: async ({ input, correction = false }: { input: string; correction?: boolean }) => {
      const target = await ensureSession();
      if (correction) return { target, notice: maskedNotice(await postInput(target, input)) };
      // Sheet picks that are @/# references ride in the message as tokens; the rest go as context lines (as in full chat).
      const tokens = chips.filter((c) => c.token && !input.includes(c.token)).map((c) => c.token);
      const typed = tokens.length ? `${input}\n\n${tokens.join(" ")}` : input;
      const extra = {
        context:
          chips
            .filter((c) => !c.token)
            .map((c) => `- ${c.label} [${c.ref}]`)
            .join("\n")
            .slice(0, 4000) || undefined,
        files: attachments.readyIds.length ? attachments.readyIds : undefined,
      };
      const run = await postInput(target, compact ? withPageContext(typed, context) : typed, false, extra);
      return { target, notice: maskedNotice(run) };
    },
    onSuccess: ({ target, notice }, { correction }) => {
      if (!correction) {
        setText("");
        setScope(null);
        setChips([]);
        if (attachments.drafts.length) {
          attachments.clear();
          void qc.invalidateQueries({ queryKey: ["chat-files", target] });
        }
        if (textarea.current && compact) textarea.current.style.height = "auto";
      }
      toast(notice ?? sentText, notice ? "warn" : undefined);
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
      else toast(sentText);
      void qc.invalidateQueries({ queryKey: ["session", sid] });
      void qc.invalidateQueries({ queryKey: ["session-exec", sid] });
      void refreshSessionLists(qc).catch(() => undefined);
    },
    onError: (err) => toast(`Not sent: ${(err as Error).message}`, "danger"),
  });
  const { mutateAsync: sendCommand } = control;
  useEffect(() => {
    if (!commandRef) return;
    commandRef.current = sid ? (text) => sendCommand(text) : null;
    return () => {
      commandRef.current = null;
    };
  }, [commandRef, sid, sendCommand]);
  const stop = useMutation({
    mutationFn: async () => {
      const runId = detail.data?.session?.activeRun?.runId;
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
    // Files picked before the conversation exists wait in `queued` until it does: sending now would leave them behind.
    if (attachments.uploading || queued.current.length) return toast("Wait for the upload to finish, then send.", "warn");
    if (send.isPending || control.isPending || d.excluded || !online) return;
    if (scope) {
      // The chip decides what the words mean: a steer, a reply, a retry (which needs no words) or a question.
      if (!text.trim() && !scopeSendsEmpty(scope)) return;
      const line = scopeMessage(scope, text);
      if (scopeIsCommand(scope) && sid)
        control.mutate(line, {
          onSuccess: () => {
            setText("");
            setScope(null);
            if (textarea.current && compact) textarea.current.style.height = "auto";
          },
        });
      else send.mutate({ input: line });
      return;
    }
    if (text.trim() || attachments.readyIds.length) send.mutate({ input: text.trim() });
  };
  const timeline = detail.data?.timeline ?? [];
  const replyActions = useMemo(
    () => new Map(actionsByReply(detail.data?.timeline ?? []).map((group) => [group.replyId, group.actions])),
    [detail.data?.timeline],
  );
  const records = (execution.data?.records?.filter((r) => r.source === "subagent" || r.source === "registered_run" || r.source === "jarvis_run") ?? [])
    .map((record, index) => ({ record, index }))
    // What needs the owner first (failed, waiting), then what is in flight, then what ended; newest first within each.
    .sort((a, b) => EXEC_ORDER[a.record.state] - EXEC_ORDER[b.record.state] || a.index - b.index)
    .map((x) => x.record);
  // Work that is also a tracked run (R-n) brings its timeline into the card.
  const tracked = useCoordinatorRuns(
    true,
    records.some((r) => r.source !== "subagent"),
  );
  const work = mergeBackgroundWork(records, tracked.data?.runs ?? []);
  const row = (w: BackgroundWork) => (
    <ExecCard
      // Keyed by what its controls reach: a row that came to control another sub-agent is a new row, so a stop
      // being confirmed on one can never be sent to the other.
      key={`${sid}:${workKey(w)}`}
      work={w}
      events={tracked.data?.events}
      pending={control.isPending}
      onControl={(input) => control.mutateAsync(input)}
      onCompose={compose}
    />
  );
  const sourceDown = !!execution.error || !!execution.data?.sources?.some((source) => source.state === "unavailable");
  const previous = discussions.data?.conversations?.filter((c) => c.placement?.parentId === d.area.id && c.id !== sid).slice(0, 5) ?? [];
  const messageGroups = groupMessages(timeline).slice(-6);
  const msgs = messageGroups.map((group) => group[0]);
  // Each piece of work is drawn once, under the reply that started it; a hand-off is not also a chip there.
  const placed = placeWork(work, msgs);
  const liveWork = placed.get("live") ?? [];
  const actionsFor = (id: string) => {
    const actions = replyActions.get(id) ?? [];
    return placed.get(id)?.length ? actions.filter((a) => a.kind !== "delegated" && a.kind !== "run_started") : actions;
  };
  const divider = sinceDivider(lastLookedChat, new Date(), sinceCounts);
  const caughtUp = divider ? sinceChips(divider.jumps) : [];
  const dividerIndex = divider ? messageGroups.findIndex((group) => group.some((m) => m.at && Date.parse(m.at) > Date.parse(lastLookedChat!))) : -1;
  const lastUser = timeline.filter((t) => t.kind === "user").at(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef<HTMLLIElement>(null);
  const positioned = useRef<string | null>(null);
  const lastId = msgs.at(-1)?.id;
  const running = !!detail.data?.session?.activeRun;
  const hasDivider = dividerIndex >= 0;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !compact || !lastId) return;
    // A chat opens where the news starts: the "Since …" divider when there is one, otherwise the latest message.
    // After that first placement it simply follows new messages.
    // (The divider can arrive a beat after the messages; it gets its one placement when it does.)
    const place = `${sid}:${hasDivider}`;
    const first = positioned.current !== place;
    positioned.current = place;
    if (first && sinceRef.current) body.scrollTop = Math.max(0, sinceRef.current.offsetTop - body.offsetTop - 4);
    else body.scrollTop = body.scrollHeight;
  }, [compact, sid, lastId, running, hasDivider]);
  return (
    <SmartSession.Provider value={sid}>
      <div ref={bodyRef} className={compact ? "gc-thread-body" : "co-body"} data-testid={compact ? "gc-thread-body" : "coordinator-body"} tabIndex={0}>
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
                  {compact
                    ? "Nothing here yet. Ask for a catch-up, or what needs you."
                    : "No coordinator conversation yet. Your first message starts one, filed in this area."}
                </p>
              </div>
            ) : null}
            {detail.isLoading ? <p className="text-sm text-muted">Loading messages…</p> : null}
            {detail.error ? (
              <p role="alert" className="text-sm text-danger">
                Couldn&apos;t load messages: {(detail.error as Error).message}{" "}
                <Button size="sm" variant="ghost" loading={detail.isFetching} onClick={() => void detail.refetch()}>
                  Try again
                </Button>
              </p>
            ) : null}
            {sid && msgs.length ? (
              <ol aria-label="Latest messages">
                {msgs.map((m, index) => (
                  <Fragment key={m.id}>
                    {index === dividerIndex && divider ? (
                      <li className="gc-since" ref={sinceRef}>
                        <div role="separator" aria-label={divider.label} className="gc-since-label">
                          <ClockIcon className="h-3.5 w-3.5" />
                          <span>{divider.label}</span>
                        </div>
                        {caughtUp.length ? (
                          <div className="gc-since-jumps">
                            {caughtUp.map((chip) => (
                              <Button
                                key={chip.key}
                                variant="ghost"
                                size="sm"
                                className={`gc-since-chip k-t-${chip.tone}`}
                                icon={SINCE_ICON[chip.key]}
                                disabled={!onJump}
                                onClick={() => onJump?.(chip.tab, chip.key)}
                              >
                                {chip.label}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ) : null}
                    {isBackgroundNotice(m.text) ? (
                      <li className="co-msg">
                        <BackgroundNotices messages={messageGroups[index]} />
                      </li>
                    ) : m.kind === "assistant" ? (
                      <li key={m.id} className="co-msg" data-who="assistant">
                        <div className="co-msg-head flex items-center justify-between gap-1">
                          <p className="text-xs font-semibold text-muted">{name}</p>
                          {sid ? (
                            <span className="flex shrink-0 items-center" data-testid="coordinator-rate">
                              <RateMessage
                                sessionId={sid}
                                messageId={m.id}
                                surface="coordinator"
                                text={m.text}
                                who="the coordinator's message"
                                model={detail.data?.session?.model ?? null}
                                onAskFix={async (prompt) => {
                                  if (send.isPending || detail.data?.session?.activeRun) {
                                    toast("Wait for the coordinator to finish, then ask again.", "warn");
                                    return false;
                                  }
                                  await send.mutateAsync({ input: prompt, correction: true });
                                  return true;
                                }}
                              />
                            </span>
                          ) : null}
                        </div>
                        <AssistantText text={m.text} />
                        <ActionsTaken actions={actionsFor(m.id)} sessionId={sid ?? undefined} areaHint={d.area.title} compact />
                        {placed.get(m.id)?.length ? (
                          <section aria-label="Work started by this reply" className="gc-bgwork">
                            {placed.get(m.id)!.map(row)}
                          </section>
                        ) : null}
                        {onRef ? <Mentions text={m.text} onRef={onRef} skip={placed.get(m.id)?.flatMap((w) => (w.run ? [w.run.ref] : []))} /> : null}
                      </li>
                    ) : (
                      <li key={m.id} className="co-msg" data-who="user">
                        <UserMessage text={m.text} sessionId={sid} />
                        {onRef ? <Mentions text={m.text} onRef={onRef} /> : null}
                      </li>
                    )}
                  </Fragment>
                ))}
              </ol>
            ) : sid && detail.isSuccess ? (
              <p className="text-sm text-muted">No messages yet.</p>
            ) : null}
            {detail.data?.session?.activeRun ? (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                <Dot tone="ai" live label="Coordinator running" />
                <span className="text-muted">{compact ? `${name} is working…` : "Working…"}</span>
                <Button size="sm" variant="ghost" loading={stop.isPending} onClick={() => stop.mutate()}>
                  Stop
                </Button>
                <Link className="inline-flex min-h-11 items-center px-2 text-accent sm:min-h-10" href={`/chat/${encodeURIComponent(sid!)}`}>
                  Open
                </Link>
              </div>
            ) : null}
            <ActionsTaken actions={actionsFor("live")} sessionId={sid ?? undefined} areaHint={d.area.title} compact />
            {sourceDown && !records.length ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                {execution.error ? "Couldn't load coordinator runs." : "Couldn't check every source of background work."}{" "}
                <Button size="sm" variant="ghost" loading={execution.isFetching} onClick={() => void execution.refetch()}>
                  Try again
                </Button>
              </p>
            ) : null}
            {/* The rows are kept current (5 s while anything runs). Freshness is said only when a refresh failed:
                "stale" is the child inventory's permanent caveat (server/chat/execution.ts), not news. */}
            {sourceDown && records.length ? (
              <LiveLine updatedAt={execution.dataUpdatedAt} failed fetching={execution.isFetching} onRetry={() => void execution.refetch()} />
            ) : null}
            {liveWork.length ? (
              <section aria-label="Work in progress" className="gc-bgwork">
                {liveWork.map(row)}
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
              <span title="Sent with your message so the answer fits what you are looking at">Viewing: {context.label}</span>
              {onAskPage ? (
                <Button variant="ghost" size="sm" onClick={onAskPage}>
                  Ask about this page
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" iconOnly icon="×" aria-label="Remove page context" onClick={onRemoveContext}>
                Remove
              </Button>
            </div>
          ) : compact && contextRemoved ? (
            <div className="gc-context-off">
              <span>This page is not shared.</span>
              <Button variant="ghost" size="sm" onClick={onRestoreContext}>
                Share page
              </Button>
            </div>
          ) : compact ? (
            <p className="gc-hint gc-context-none">No page context is shared.</p>
          ) : null}
          {compact && (text.trim() || scope) ? null : (
            <QuickActionChips variant="row" context={quickContext ?? { areaId: d.area.id, areaTitle: d.area.title, path: pathname }} onPrompt={fill} />
          )}
          <label htmlFor={`${titleId}-m`} className="sr-only">
            Message the coordinator
          </label>
          {compact ? (
            <>
              {chips.length ? (
                <div className="gc-chips" role="group" aria-label="Context to send">
                  {chips.map((c) => (
                    <ChipButton key={c.ref} aria-label={`Remove context ${c.label}`} onClick={() => setChips((all) => all.filter((x) => x.ref !== c.ref))}>
                      {c.label} ×
                    </ChipButton>
                  ))}
                </div>
              ) : null}
              <AttachmentChips drafts={attachments.drafts} onRemove={attachments.remove} onRetry={attachments.retry} />
            </>
          ) : null}
          {scope ? (
            // What the next message is about. Remove it (or Backspace in the empty field) to write an ordinary message.
            <div className="gc-scope" role="group" aria-label={scopeLabel(scope)} data-kind={scope.ref?.startsWith("D-") ? "d" : "r"} data-testid="gc-scope">
              <span className="k-ref" data-kind={scope.ref?.startsWith("D-") ? "d" : "r"}>
                {scopeChip(scope)}
              </span>
              <span className="gc-scope-title">{scope.title}</span>
              <Button variant="ghost" size="sm" iconOnly icon="×" aria-label={`Remove ${scopeChip(scope)} from the message`} onClick={() => setScope(null)}>
                Remove
              </Button>
            </div>
          ) : null}
          <div className={compact ? "gc-compose-row" : undefined}>
            {compact ? (
              <div className="gc-add-menu">
                <Button
                  ref={addButton}
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<PlusIcon className="h-4 w-4" />}
                  className="gc-add"
                  aria-label="Add to message"
                  aria-haspopup="menu"
                  aria-expanded={adding}
                  onClick={() => setAdding((v) => !v)}
                >
                  Add
                </Button>
                {adding ? (
                  <Menu
                    label="Add to message"
                    items={[
                      { label: "Photo or file", onSelect: () => fileInput.current?.click(), disabled: !online },
                      { label: "Camera", onSelect: () => cameraInput.current?.click(), disabled: !online },
                      { label: "Area, item or person", onSelect: () => setSheet(true) },
                    ]}
                    onClose={() => {
                      setAdding(false);
                      addButton.current?.focus();
                    }}
                  />
                ) : null}
                <span hidden>
                  <AttachButton onFiles={attach} disabled={!online} inputRef={fileInput} testId="gc-file-input" />
                  <CameraButton onFiles={attach} disabled={!online} inputRef={cameraInput} testId="gc-camera-input" />
                </span>
              </div>
            ) : null}
            <Textarea
              ref={textarea}
              id={`${titleId}-m`}
              data-autofocus
              data-testid={compact ? "gc-input" : "coordinator-input"}
              className={compact ? "gc-input" : "gc-thread-input w-full min-w-0 resize-y"}
              rows={compact ? 1 : text.length > 200 ? 8 : 3}
              maxLength={8000}
              value={text}
              placeholder={
                scope
                  ? scopePlaceholder(scope)
                  : compact
                    ? `Ask ${name === "Coordinator" ? "the coordinator" : "your " + name.toLowerCase()}…`
                    : "Ask the coordinator…"
              }
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
                } else if (e.key === "Backspace" && scope && !text) {
                  e.preventDefault();
                  setScope(null);
                }
              }}
              onPaste={(e) => {
                if (!compact) return;
                const files = pastedFiles(e);
                if (files.length) {
                  e.preventDefault();
                  attach(files);
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
                disabled={(scope ? !text.trim() && !scopeSendsEmpty(scope) : !text.trim() && !attachments.readyIds.length) || !online}
                loading={send.isPending || (!!scope && control.isPending)}
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
                disabled={(!text.trim() && !(scope && scopeSendsEmpty(scope))) || !online}
                loading={send.isPending || (!!scope && control.isPending)}
                data-testid="coordinator-send"
              >
                Send
              </Button>
            </div>
          ) : (
            <>
              {!online ? (
                <p className="gc-hint" role="status" data-tone="warn">
                  You&apos;re offline. Your draft is kept; send it when you&apos;re back.
                </p>
              ) : null}
              <p className="gc-hint gc-keys">Ctrl/⌘+Enter to send · Enter for a new line</p>
            </>
          )}
        </form>
      ) : null}
      {sheet ? (
        <ContextSheet
          open
          onClose={() => setSheet(false)}
          sessionId={sid ?? ""}
          areaTitle={d.area.title}
          selected={chips}
          onToggle={(chip) => setChips((all) => (all.some((x) => x.ref === chip.ref) ? all.filter((x) => x.ref !== chip.ref) : [...all, chip].slice(0, 12)))}
        />
      ) : null}
    </SmartSession.Provider>
  );
}

/** What the owner sent: their words in a bubble; machine wrappers become a quiet caption or a compact receipt. */
function UserMessage({ text, sessionId }: { text: string; sessionId?: string | null }) {
  const { body, attached } = splitAttachedContext(text);
  const parts = parseUserMessage(body);
  const fileIds = parseFileMarkers(attached);
  // A long dictated message folds to a few lines: the reply is what the owner came for.
  const long = parts.text.length > 320 || parts.text.split("\n").length > 6;
  const [open, setOpen] = useState(false);
  if (parts.decision)
    return (
      <div className="gc-receipt">
        <p className="gc-receipt-head">You decided · {parts.decision.title}</p>
        <p className="gc-receipt-answer">{parts.decision.answer}</p>
        <details>
          <summary>The question</summary>
          <p className="whitespace-pre-wrap">{parts.decision.question}</p>
        </details>
      </div>
    );
  return (
    <>
      <span className="sr-only">You said: </span>
      <div className="gc-bubble">
        <p className={`whitespace-pre-wrap${long && !open ? " line-clamp-4" : ""}`}>{parts.text}</p>
        {long ? (
          <Button variant="ghost" size="sm" className="gc-bubble-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : "Show all"}
          </Button>
        ) : null}
      </div>
      {fileIds.length && sessionId ? <SentFiles sessionId={sessionId} ids={fileIds} /> : null}
      {parts.context ? <p className="gc-msg-context">Sent while viewing {parts.context.label}</p> : null}
    </>
  );
}

function SentFiles({ sessionId, ids }: { sessionId: string; ids: string[] }) {
  const files = useConversationFiles(sessionId);
  return <MessageAttachments sessionId={sessionId} ids={ids} files={files.data ?? []} />;
}

type ThreadMessage = Extract<TimelineItem, { kind: "user" | "assistant" | "system" }>;
function isBackgroundNotice(text: string) {
  const notice = parseNotice(text);
  return notice?.kind === "process" || notice?.kind === "delegation";
}
/** Consecutive completion frames form one folded group, including role=system frames. */
function groupMessages(timeline: TimelineItem[]) {
  const groups: ThreadMessage[][] = [];
  for (const message of timeline) {
    if (message.kind === "tool" || (message.kind === "system" && !isBackgroundNotice(message.text))) continue;
    const previous = groups.at(-1);
    if (isBackgroundNotice(message.text) && previous && isBackgroundNotice(previous[0].text)) previous.push(message);
    else groups.push([message]);
  }
  return groups;
}
function BackgroundNotices({ messages }: { messages: ThreadMessage[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="gc-background-notices">
      <ChipButton aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {messages.length === 1 ? "1 background notice" : `${messages.length} background notices`}
      </ChipButton>
      {open ? (
        <ul id={id}>
          {messages.map((message) => (
            <li key={message.id}>
              <p className="text-xs text-muted">{parseNotice(message.text)?.kind === "process" ? "Process" : "Delegation"}</p>
              <Markdown text={message.text} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
function Mentions({ text, onRef, skip = [] }: { text: string; onRef: (ref: string) => void; skip?: string[] }) {
  // Keep the Markdown renderer untouched; code and link destinations are not prose mentions.
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|\]\([^)]*\)/g, " ");
  // A run that already has its row under this message is not also a mention chip.
  const mentions = [...new Set(refChips(prose).map((chip) => chip.ref))].filter((ref) => !skip.includes(ref));
  return mentions.length ? (
    <div className="gc-mentions" aria-label="Mentions">
      <span>Mentions:</span>
      {mentions.map((ref) => (
        <ChipButton key={ref} aria-label={`${ref.startsWith("D") ? "Decision" : "Run"} ${ref.replace("-", " ")}`} onClick={() => onRef(ref)}>
          {ref}
        </ChipButton>
      ))}
    </div>
  ) : null;
}

/** Background work in the order the owner needs it. */
const EXEC_ORDER: Record<ExecutionRecord["state"], number> = { failed: 0, waiting: 1, running: 2, unknown: 3, completed: 4, cancelled: 5 };
const SINCE_ICON: Record<SinceChip["key"], ReactNode> = {
  failed: <AlertIcon className="h-3.5 w-3.5" />,
  decisions: <InboxIcon className="h-3.5 w-3.5" />,
  waiting: <BellIcon className="h-3.5 w-3.5" />,
  stuck: <AlertIcon className="h-3.5 w-3.5" />,
  finished: <CheckIcon className="h-3.5 w-3.5" />,
  runs: <BoltIcon className="h-3.5 w-3.5" />,
};
