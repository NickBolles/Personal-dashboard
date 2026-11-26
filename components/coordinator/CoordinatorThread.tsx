"use client";

import Link from "next/link";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { AgentResolution } from "@/lib/agents";
import { maskedNotice, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { Markdown, MarkdownRefRenderer } from "@/components/markdown/Markdown";
import { AssistantText, useSmartSettings } from "@/components/smart/AssistantText";
import { MessageAttachments, useChatAttachments, useConversationFiles } from "@/components/chat/Attachments";
import { ContextSheet, type ContextChip } from "@/components/chat/ContextSheet";
import { parseFileMarkers } from "@/lib/chat-files";
import { AlertIcon, BellIcon, BoltIcon, CheckIcon, ClockIcon, InboxIcon, PanelIcon } from "@/components/icons";
import { RateMessage } from "@/components/feedback/RateMessage";
import { Button, ChipButton, Dot, IconButton, RefPill, SectionHeader, useOnline, useToast } from "@/components/ui";
import { ChatTray } from "@/components/chat/things/ChatTray";
import { ChatPanel } from "@/components/chat/things/ChatPanel";
import { useChatThings } from "@/components/chat/things/useChatThings";
import { usePanelLinks } from "@/components/chat/LinksPanel";
import { ModelSelectDialog } from "@/components/areas/ModelPicker";
import type { ThingsTab } from "@/lib/chat/things";
import { Composer, type ComposerHandle } from "@/components/chat/Composer";
import { AssistantName, LiveRun, ToolGroup, liveRunVisible, toolRunsByReply, groupTimeline } from "@/components/chat/Timeline";
import { useRunStream, type RunState } from "@/components/chat/useRunStream";
import { useRunAnswers } from "@/components/chat/useRunAnswers";
import { kvDel, kvGet, kvSet } from "@/lib/client/idb";
import { scopeChip, scopeIsCommand, scopeLabel, scopeMessage, scopePlaceholder, scopeSendsEmpty, type ComposeScope } from "@/lib/coordinator/compose";
import { parseNotice } from "@/lib/chat-notices";
import { refChips, sinceDivider } from "@/lib/coordinator/runs-view";
import { withPageContext, type PageContext } from "@/lib/coordinator/page-context";
import { COORDINATOR_PROMPT, type QuickActionContext } from "@/lib/quick-actions";
import { COORDINATOR_PINNED_THREAD } from "@/components/navigation/commands";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { ProposedQuickActions } from "@/components/quick-actions/ProposedQuickActions";
import { useQuickActions } from "@/components/quick-actions/useQuickActions";
import { ActionsTaken } from "@/components/chat/ActionsTaken";

import { actionsByReply } from "@/lib/chat/actions";
import { isActiveExec, type ChatExecutionResponse } from "@/lib/chat-execution";
import { sinceChips, mergeBackgroundWork, type SinceChip, type SinceCounts } from "@/lib/coordinator/run-card";
import { ExecCard } from "@/components/coordinator/running/RunCard";
import { useCoordinatorRuns } from "@/components/coordinator/running/useCoordinatorRuns";

import type { ConversationListResponse } from "@/lib/work";
import { parseUserMessage, splitAttachedContext } from "@/lib/chat/display";
// PR A (pinned Chief of staff thread): thread switcher, paging, live decisions and questionnaire replies.
import { ThreadBar, usePinThread } from "@/components/coordinator/thread/ThreadBar";
import { EarlierThreads } from "@/components/coordinator/thread/EarlierThreads";
import { isOpsConversation } from "@/lib/coordinator/thread";
import { CHIEF_THREAD, THREAD_FIRST_PAGE, THREAD_PAGE, visibleGroupCount, type ThreadSelection } from "@/lib/coordinator/thread";
import { SmartScope } from "@/components/smart/SmartScope";
import { smartDecisionRefs } from "@/lib/jarvis-ui/live";
import "@/components/agents/agents.css";

export type CoordinatorResponse = {
  area: { id: string; title: string };
  agent: AgentResolution;
  sessionId: string | null;
  sessionTitle: string | null;
  /** PR A: the thread is the owner's pinned one (false = picked by the newest-conversation rule) */
  pinned?: boolean;
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
  standalone,
  onRemoveContext,
  onRestoreContext,
  onAskPage,
  draft,
  onDraft,
  selection,
  onSelection,
  inlineActions,
  quickContext,
  lastLookedChat,
  sinceCounts = { decisions: 0, runs: 0 },
  onJump,
  onRef,
  commandRef,
  scope: scopeProp,
  onScope,
  mentions,
  onAnswer,
  tasksSlot = null,
  tasksOpen = false,
  onShowChat,
}: {
  /**
   * What the next message is about (the chip in the composer): set by Steer, Reply, Retry or "ask about this" on
   * a row here or in another tab. Controlled by the host when it passes `onScope`; kept here otherwise.
   */
  scope?: ComposeScope | null;
  onScope?: (scope: ComposeScope | null) => void;
  /**
   * The rich rows for what a reply mentions (D-n / R-n). `rank` says whether a reference can be drawn here and
   * where it sorts (lower first; null = not drawable, it stays a chip in the text); `render` draws its row.
   */
  mentions?: { rank: (ref: string) => number | null; render: (ref: string) => ReactNode };
  /**
   * Records what was typed as the answer to the decision in the chip (scope kind "answer"). Resolves true when it
   * was recorded. `confirmed` is the owner's second send on a risk-flagged decision.
   */
  onAnswer?: (scope: ComposeScope, text: string, confirmed: boolean) => Promise<boolean>;
  info: CoordinatorResponse;
  compact?: boolean;
  /** Who the owner is talking to, as shown on replies ("Chief of staff" in the global rail). */
  name?: string;
  context?: PageContext | null;
  /** The owner turned this page's context off (it can be shared again). */
  contextRemoved?: boolean;
  /** The panel is the page itself (Expand): there is no other page whose context could be shared, so say nothing. */
  standalone?: boolean;
  onRemoveContext?: () => void;
  onRestoreContext?: () => void;
  /** Fills the composer with a question about the page being viewed. Never sends. */
  onAskPage?: () => void;
  draft?: string;
  onDraft?: (text: string) => void;
  /**
   * Which thread the panel is on, when the host keeps it (as it keeps the draft). The phone sheet unmounts this
   * component when it closes: without the host's copy it would reopen on the Chief of staff thread with a draft
   * that was written for another one.
   */
  selection?: ThreadSelection;
  onSelection?: Dispatch<SetStateAction<ThreadSelection>>;
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
  /**
   * Area panes: the element inside the pane's own Tasks tab where this conversation's background work (sub-agents
   * with Steer/Stop) is listed. Chat never shows those inventories. `tasksOpen` = that tab is showing;
   * `onShowChat` switches back to Chat when Steer/Reply puts a chip in the composer.
   */
  tasksSlot?: HTMLElement | null;
  tasksOpen?: boolean;
  onShowChat?: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const online = useOnline();
  const sentText = compact ? `Sent to your ${name}` : "Sent to the coordinator";
  const [localText, setLocalText] = useState("");
  const text = draft ?? localText;
  const setText = onDraft ?? setLocalText;
  const [ownSelection, setOwnSelection] = useState<ThreadSelection>(CHIEF_THREAD);
  const { sessionId, fresh } = selection ?? ownSelection;
  const select = onSelection ?? setOwnSelection;
  const setSessionId = (id: string | null) => select((now) => ({ ...now, sessionId: id }));
  const setFresh = (value: boolean) => select((now) => ({ ...now, fresh: value }));
  /** How many earlier threads are drawn above this one (greyed, behind their dividers). */
  const [back, setBack] = useState<{ sid: string | null; n: number }>({ sid: null, n: 0 });
  const [shown, setShown] = useState<{ sid: string | null; n: number }>({ sid: null, n: THREAD_FIRST_PAGE });
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => {
    if (!compact) composer.current?.focus();
  }, [compact]);
  const [localScope, setLocalScope] = useState<ComposeScope | null>(null);
  const scope = onScope ? (scopeProp ?? null) : localScope;
  const setScope = onScope ?? setLocalScope;
  // One composer: a row's Steer / Reply / Retry puts its chip here and hands over the keyboard.
  // A risky decision's typed answer is sent on the second press: the first one arms it, for exactly these words.
  const [armed, setArmed] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const answerKey = scope?.kind === "answer" ? `${scope.ref}:${text.trim()}` : null;
  const confirming = armed !== null && armed === answerKey;

  /** The chip belongs to the draft it was set for: a new draft from elsewhere or another thread starts without it. */
  const dropScope = () => {
    setScope(null);
    setArmed(null);
  };
  const sid = fresh ? null : (sessionId ?? d.sessionId);
  const pinThread = usePinThread(d.area.id);
  // The run in flight streams here, on the one stream every reader of that run shares (lib/client/run-streams.ts):
  // the rail, the sheet and a chat page showing the same run cost Hermes one connection between them.
  const clearRun = useRef<() => void>(() => {});
  /** The conversation on screen and the run of it that was taken up (see the follow effect below). */
  const followed = useRef<{ sid: string | null; runId: string | null }>({ sid, runId: null });
  const onRunEnd = useCallback(
    (ended: RunState) => {
      void qc.invalidateQueries({ queryKey: ["session-exec", sid] });
      void qc.invalidateQueries({ queryKey: ["work", "coordinator"] });
      void refreshSessionLists(qc).catch(() => undefined);
      // Once the saved conversation has this turn, the live copy goes. A run that failed stays on screen.
      // By then the owner may have opened another thread, or this one may have started its next run: the stream
      // held now is that one's, and it is not this run's to clear.
      void qc.refetchQueries({ queryKey: ["session", sid] }).then(() => {
        if (ended.phase === "completed" && followed.current.sid === sid && followed.current.runId === ended.runId) clearRun.current();
      });
    },
    [qc, sid],
  );
  const run = useRunStream(onRunEnd);
  /** The stream is open and delivering: not waiting to reconnect, not given up. */
  const streaming = run.active && run.state.phase !== "reconnecting" && run.state.phase !== "disconnected";
  useEffect(() => {
    clearRun.current = run.clear;
  });
  // Excluded areas fetch nothing at all.
  const smartSettings = useSmartSettings(!d.excluded);
  /** An earlier thread is open in the panel (not the Chief of staff thread). */
  const viewingEarlier = !!sessionId && !!d.sessionId && sessionId !== d.sessionId && !fresh;
  const pathname = usePathname();
  const quickActions = useQuickActions(!d.excluded);
  const hasProposals = !!quickActions.data?.actions.some((a) => a.status === "proposed");
  const fill = (value: string) => {
    // A quick action is a whole message of its own: it is never about the thing an earlier chip named.
    dropScope();
    setText(value.slice(0, 8000));
    requestAnimationFrame(() => composer.current?.focus());
  };
  const fillRef = useRef(fill);
  useEffect(() => {
    fillRef.current = fill;
  });
  useEffect(() => {
    // The area pane takes ⌘K quick actions while it is open; the global rail/sheet handles them otherwise.
    if (compact || d.excluded) return;
    const onPrompt = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; target?: "chief" }>).detail;
      if (detail?.target === "chief") return;
      const value = detail?.text;
      if (typeof value === "string") fillRef.current(value);
    };
    window.addEventListener(COORDINATOR_PROMPT, onPrompt);
    return () => window.removeEventListener(COORDINATOR_PROMPT, onPrompt);
  }, [compact, d.excluded]);
  const detail = useQuery({
    queryKey: ["session", sid],
    queryFn: () => api.get<Detail>(`/api/hermes/sessions/${encodeURIComponent(sid!)}`),
    enabled: !!sid && !d.excluded,
    // The run itself arrives over its stream. Polling is only the fallback for a run that is not streaming here.
    refetchInterval: (q) => (q.state.data?.session?.activeRun && !streaming ? 3000 : false),
  });
  const execution = useQuery({
    queryKey: ["session-exec", sid],
    queryFn: () => api.get<ChatExecutionResponse>(`/api/hermes/sessions/${encodeURIComponent(sid!)}/execution`),
    enabled: !!sid && !d.excluded,
    refetchInterval: (q) => (detail.data?.session?.activeRun || q.state.data?.records?.some(isActiveExec) ? 5000 : 15000),
  });
  // Follow the run this conversation has in flight; each run is taken up once (a finished one is not reopened by a
  // session that has not caught up yet). Another thread is another conversation: its run is not this one's.
  const activeRun = detail.data?.session?.activeRun;
  const { start: startRun, clear: clearLive } = run;
  const liveRunId = run.active ? run.state.runId : undefined;
  const sessionFresh = detail.isSuccess && !detail.isFetching;
  useEffect(() => {
    if (followed.current.sid !== sid) {
      followed.current = { sid, runId: null };
      clearLive();
    }
    if (activeRun) {
      if (followed.current.runId === activeRun.runId) return;
      followed.current.runId = activeRun.runId;
      startRun(activeRun.runId, activeRun.status === "queued" ? "queued" : activeRun.status === "waiting_for_approval" ? "waiting_for_approval" : "running");
      return;
    }
    // The conversation, freshly read, says nothing is running. A stream still open for the run we followed has
    // missed its ending (a dropped connection, a tab that slept): the saved conversation is the truth, so let go.
    if (sessionFresh && liveRunId && liveRunId === followed.current.runId) {
      clearLive();
      void qc.invalidateQueries({ queryKey: ["session-exec", sid] });
    }
  }, [sid, activeRun, startRun, clearLive, sessionFresh, liveRunId, qc]);
  const { answerApproval, answerClarify } = useRunAnswers(run.state);
  // The model for this conversation, kept on this device as the chat page keeps it.
  const [model, setModel] = useState<{ sid: string | null; model?: string; provider?: string }>({ sid: null });
  const [modelOpen, setModelOpen] = useState(false);
  useEffect(() => {
    if (!sid) return;
    let live = true;
    void kvGet<{ model?: string; provider?: string }>(`model:${sid}`).then((saved) => {
      if (live) setModel({ sid, ...(saved ?? {}) });
    });
    return () => {
      live = false;
    };
  }, [sid]);
  const chosen = model.sid === sid ? { model: model.model, provider: model.provider } : {};
  // "In this chat": the same status bar and sheet as any chat, fed by the background-work read this thread already keeps.
  const panel = usePanelLinks(d.excluded ? "" : (sid ?? ""), detail.data?.timeline ?? NO_ITEMS, d.excluded || !sid);
  const waitingOn = run.state.approval
    ? run.state.approval.description || run.state.approval.command
    : run.state.clarify && run.active
      ? run.state.clarify.question
      : undefined;
  // The bar says what is happening now. Work that has ended is not news here: the thread draws it under the reply
  // that started it, Activity keeps the rest, and the sheet still lists everything.
  const known = execution.data && Array.isArray(execution.data.records) && Array.isArray(execution.data.sources) ? execution.data : undefined;
  const happening = useMemo(() => (known ? { ...known, records: known.records.filter(isActiveExec) } : execution.data), [known, execution.data]);
  const chat = useChatThings(
    sid ?? "",
    {
      links: panel.links,
      pending: { approval: !!run.state.approval, clarify: !!run.state.clarify && run.active, detail: waitingOn, runId: run.state.runId },
      parentRunning: !!activeRun || run.active,
      parentFailed: run.state.phase === "failed" || run.state.phase === "interrupted",
      expectsBackground: !!execution.data?.records?.length,
      filesCount: null,
      contextPercent: null,
    },
    { data: happening, isError: execution.isError, isPending: execution.isPending, refetch: () => execution.refetch() },
  );
  const [things, setThings] = useState<ThingsTab | null>(null);
  const openThings = (tab: ThingsTab) => {
    setThings(tab);
    chat.markSeen(tab);
  };
  const discussions = useQuery({
    queryKey: ["work", "conversations", "coordinator-earlier", d.area.id],
    queryFn: () => api.get<ConversationListResponse>(`/api/work/conversations?view=all&areaId=${encodeURIComponent(d.area.id)}`),
    enabled: !d.excluded,
    staleTime: 60_000,
  });
  const postInput = (
    target: string,
    input: string,
    control = false,
    extra: { context?: string; files?: string[] } = {},
    key?: string,
  ): Promise<{ masked?: string[] } | null> => {
    const active = detail.data?.session?.activeRun;
    if (control && active) return api.post<{ masked?: string[] } | null>(`/api/hermes/runs/${encodeURIComponent(active.runId)}/steer`, { input });
    return api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(target)}/runs`, {
      input,
      idempotencyKey: key ?? newIdempotencyKey(control ? "ctl" : "coord"),
      capabilities: [SMART_CAPABILITY],
      ...extra,
      ...(chosen.model ? chosen : {}),
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
        // A thread the panel starts is the Chief of staff thread from now on.
        pinThread.mutate(s.id);
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
  const [sheet, setSheet] = useState(false);
  /** Opens a thread in the panel: an earlier one by id, or (null) the Chief of staff thread itself. */
  const openThread = (id: string | null) => {
    // Attachments and context picked for one thread never ride along to another.
    if (attachments.drafts.length) attachments.clear();
    setChips([]);
    dropScope();
    setFresh(false);
    setSessionId(id);
  };
  const onThread = sessionId !== null || fresh;
  const openThreadRef = useRef(openThread);
  useEffect(() => {
    openThreadRef.current = openThread;
  });
  useEffect(() => {
    // The pinned thread's own address was asked for (/chat/<id> leads to /chief): show that thread, not the earlier
    // or new one the panel happens to be on. Already there, nothing is touched.
    if (!standalone || !onThread) return;
    const onPinned = () => openThreadRef.current(null);
    window.addEventListener(COORDINATOR_PINNED_THREAD, onPinned);
    return () => window.removeEventListener(COORDINATOR_PINNED_THREAD, onPinned);
  }, [standalone, onThread]);
  const send = useMutation({
    mutationFn: async ({ input, correction = false, key }: { input: string; correction?: boolean; key?: string }) => {
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
      // Kept on this device until Hermes has the message: a send that did not get through is retried with the same
      // key (after a reload too), so it never runs twice.
      if (key) await kvSet(`pending:${target}`, { input, key });
      const run = await postInput(target, compact ? withPageContext(typed, context) : typed, false, extra, key);
      if (key) await kvDel(`pending:${target}`);
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
      }
      toast(notice ?? sentText, notice ? "warn" : undefined);
      // The owner's first message in the thread the panel picked makes it the pinned Chief of staff thread.
      if (!d.pinned && !viewingEarlier && target === d.sessionId && !pinThread.isPending) pinThread.mutate(target);
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
  const sendMessage = (input: string, key?: string) =>
    send.mutateAsync({ input, key }).then(
      () => true,
      () => false,
    );
  const sendControl = (line: string) =>
    control.mutateAsync(line).then(
      () => true,
      () => false,
    );
  // A risky decision's typed answer is recorded on the second press: the first one arms it, for exactly these words.
  const canSend = (said: string) => {
    if (scope?.kind !== "answer" || !onAnswer || !scope.risky || confirming) return true;
    if (said) setArmed(answerKey);
    return false;
  };
  /**
   * What the composer's Send means here. The chip decides first (an answer to record, a one-line command, a
   * question); with no chip the words are guidance for the run in flight, or the next message.
   * Resolves true when the words went somewhere, and the composer then clears itself.
   */
  const deliver = async (said: string, key?: string): Promise<boolean> => {
    // Files picked before the conversation exists wait in `queued` until it does: sending now would leave them behind.
    if (attachments.uploading || queued.current.length) {
      toast("Wait for the upload to finish, then send.", "warn");
      return false;
    }
    if (d.excluded) return false;
    if (scope?.kind === "answer" && onAnswer) {
      if (!said || answering) return false;
      setAnswering(true);
      try {
        const recorded = await onAnswer(scope, said, confirming);
        if (recorded) setScope(null);
        return recorded;
      } finally {
        setArmed(null);
        setAnswering(false);
      }
    }
    if (scope) {
      // The chip decides what the words mean: a steer, a reply, a retry (which needs no words) or a question.
      if (!said && !scopeSendsEmpty(scope)) return false;
      const line = scopeMessage(scope, said);
      if (!scopeIsCommand(scope) || !sid) return sendMessage(line, key);
      const sent = await sendControl(line);
      if (sent) setScope(null);
      return sent;
    }
    return running ? sendControl(said) : sendMessage(said, key);
  };
  const timeline = detail.data?.timeline ?? [];
  // The tool work behind each reply, as the one folded row every chat draws (it opens to the steps).
  const toolHistory = useMemo(
    () => (detail.data?.timeline ?? NO_ITEMS).filter((item) => !("text" in item && isBackgroundNotice(item.text))),
    [detail.data?.timeline],
  );
  const toolRuns = useMemo(() => toolRunsByReply(toolHistory), [toolHistory]);
  const trailingTools = useMemo(() => {
    const last = groupTimeline(toolHistory).at(-1);
    return last && "tools" in last ? last : null;
  }, [toolHistory]);
  const replyActions = useMemo(
    () => new Map(actionsByReply(detail.data?.timeline ?? []).map((group) => [group.replyId, group.actions])),
    [detail.data?.timeline],
  );
  // Area panes list this conversation's background work under their Tasks tab (portal below), never in Chat.
  const tracked = useCoordinatorRuns(tasksOpen, !compact && tasksOpen && !!tasksSlot);
  const workId = useId();
  const areaWork = mergeBackgroundWork(execution.data?.records ?? [], tracked.data?.runs ?? []);
  const sourceDown = !!execution.error || !!execution.data?.sources?.some((source) => source.state === "unavailable");
  // This bot's other threads, newest first: the top of the chat, above the one on screen.
  const previous = (discussions.data?.conversations ?? [])
    .filter((c) => c.placement?.parentId === d.area.id && c.id !== sid && !isOpsConversation(c))
    .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""))
    .slice(0, 20)
    .map((c) => ({ id: c.id, title: c.title, lastActiveAt: c.lastActiveAt }));
  const backShown = back.sid === sid ? back.n : 0;
  // "Load earlier" pages through the thread already loaded (no extra Hermes requests); the first page always reaches
  // back to the "Since …" divider.
  const allGroups = groupMessages(timeline);
  const firstNew =
    lastLookedChat && sinceDivider(lastLookedChat, new Date(), sinceCounts)
      ? allGroups.findIndex((group) => group.some((m) => m.at && Date.parse(m.at) > Date.parse(lastLookedChat)))
      : -1;
  // A message link ("#msg-<id>", as the feedback inbox writes them) that led here: on /chief this thread is the
  // conversation the link is about, so the message is revealed (however far back) and brought into view.
  const hash = useSyncExternalStore(subscribeHash, readHash, noHash);
  const linked = standalone ? linkedMessage(hash) : null;
  const linkedGroup = linked ? allGroups.findIndex((group) => group.some((m) => m.id === linked)) : -1;
  const linkedRow = linkedGroup >= 0 ? allGroups[linkedGroup][0].id : null;
  const reach = [firstNew, linkedGroup].filter((i) => i >= 0);
  const shownCount = visibleGroupCount(allGroups.length, shown.sid === sid ? shown.n : THREAD_FIRST_PAGE, reach.length ? Math.min(...reach) : -1);
  const hiddenGroups = allGroups.length - shownCount;
  const messageGroups = allGroups.slice(hiddenGroups);
  const msgs = messageGroups.map((group) => group[0]);
  // Actions are part of the real conversation. The full background-work inventory lives in Tasks, not in Chat.
  const actionsFor = (id: string) => replyActions.get(id) ?? [];
  // Work rows are exclusive to Tasks. Chat only draws host-provided decision and task mentions.
  const smartOn = !!smartSettings.data?.enabled;
  const drawn = new Set<string>();
  // Only suppress rows actually replaced by the enabled rich renderer. Smart-off keeps native owner-session controls.
  if (smartOn) for (const m of msgs) if (m.kind === "assistant") for (const ref of smartDecisionRefs(m.text)) drawn.add(ref);
  const mentionedBy = new Map<string, string>();
  for (const m of msgs)
    if (m.kind === "assistant") for (const ref of new Set([...proseRefs(m.text), ...(!smartOn ? smartDecisionRefs(m.text) : [])])) mentionedBy.set(ref, m.id);
  const mentionRows = (id: string) =>
    mentions
      ? [...mentionedBy]
          .filter(([ref, at]) => at === id && !drawn.has(ref))
          .flatMap(([ref]) => {
            const rank = mentions.rank(ref);
            return rank === null ? [] : [{ ref, rank }];
          })
          .sort((x, y) => x.rank - y.rank)
          .map((x) => x.ref)
      : [];
  const divider = sinceDivider(lastLookedChat, new Date(), sinceCounts);
  const caughtUp = divider ? sinceChips(divider.jumps) : [];
  const dividerIndex = divider ? messageGroups.findIndex((group) => group.some((m) => m.at && Date.parse(m.at) > Date.parse(lastLookedChat!))) : -1;
  const lastUser = timeline.filter((t) => t.kind === "user").at(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef<HTMLLIElement>(null);
  const positioned = useRef<string | null>(null);
  const lastId = msgs.at(-1)?.id;
  const running = !!activeRun || run.active;
  const showLive = liveRunVisible(run.state, run.active, timeline);
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
  // While a run writes, the thread stays on its last line, unless the owner has scrolled up to read.
  const atBottom = useRef(true);
  useEffect(() => {
    if (!linkedRow) return;
    // After the thread's own first placement (above), which would otherwise win.
    const frame = requestAnimationFrame(() => {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>("[data-msg]") ?? [];
      const target = [...rows].find((row) => row.dataset.msg === linkedRow);
      if (!target) return;
      target.scrollIntoView?.({ block: "center" });
      target.setAttribute("data-landed", "");
      window.setTimeout(() => target.removeAttribute("data-landed"), 1900);
      atBottom.current = false;
      // What was revealed for the link stays revealed; the link itself is used up, and the address is /chief again.
      setShown({ sid, n: shownCount });
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    });
    return () => cancelAnimationFrame(frame);
  }, [linkedRow, sid, shownCount]);
  const liveSize = run.state.text.length + run.state.activity.length + (run.state.approval ? 1 : 0) + (run.state.clarify ? 1 : 0);
  useEffect(() => {
    const body = bodyRef.current;
    if (body && compact && showLive && atBottom.current) body.scrollTop = body.scrollHeight;
  }, [compact, showLive, liveSize]);
  // A reference chip in the text jumps to the thing's row when it is on screen here, else to its tab.
  const jumpTo = (ref: string) => {
    const target = bodyRef.current?.querySelector<HTMLElement>(`[data-run-ref="${ref}"], [data-ref-row="${ref}"]`);
    if (!target) return onRef?.(ref);
    target.scrollIntoView?.({ block: "nearest" });
    target.setAttribute("data-landed", "");
    window.setTimeout(() => target.removeAttribute("data-landed"), 1900);
    target.querySelector<HTMLElement>(".k-thing-title, [data-thing-toggle]")?.focus({ preventScroll: true });
  };
  const refChip = onRef ? (ref: string) => <RefPill id={ref} onClick={() => jumpTo(ref)} className="gc-inline-ref" /> : null;
  /** One more earlier thread above the ones drawn, keeping what the owner was reading where it was. */
  const loadEarlierThread = () => {
    const body = bodyRef.current;
    const before = body ? body.scrollHeight - body.scrollTop : 0;
    setBack({ sid, n: backShown + 1 });
    requestAnimationFrame(() => {
      if (body) body.scrollTop = body.scrollHeight - before;
    });
  };
  const earlierMessage = (m: Extract<TimelineItem, { kind: "user" | "assistant" }>) =>
    m.kind === "assistant" ? (
      <>
        <p className="text-xs font-semibold text-muted">{name}</p>
        <AssistantText text={m.text} messageId={m.id} />
      </>
    ) : (
      <UserMessage text={m.text} />
    );
  // On an earlier thread the bar says so and leads back: the history is drawn above the current thread only.
  const earlierThreads =
    previous.length && !viewingEarlier && (!sid || hiddenGroups === 0) ? (
      <EarlierThreads threads={previous} shown={backShown} onMore={loadEarlierThread} render={earlierMessage} />
    ) : null;
  const loadEarlier = () => {
    const body = bodyRef.current;
    const before = body ? body.scrollHeight - body.scrollTop : 0;
    setShown({ sid, n: shownCount + THREAD_PAGE });
    // Keep the message the owner was reading where it was.
    requestAnimationFrame(() => {
      if (body) body.scrollTop = body.scrollHeight - before;
    });
  };
  // F1: an open D-n decision a reply draws as a smart card is the live decision block (answer in place, Undo).
  const liveDecision = mentions ? (ref: string) => (ref.startsWith("D-") && mentions.rank(ref) !== null ? mentions.render(ref) : null) : null;
  // F2: a questionnaire form's Submit answers in this thread.
  // It is its own message: it never takes the composer's draft, chips, scope or attachments with it.
  const smartReply = async (input: string, key?: string) => {
    try {
      const target = await ensureSession();
      const notice = maskedNotice(await postInput(target, input, false, {}, key));
      toast(notice ?? sentText, notice ? "warn" : undefined);
      void qc.invalidateQueries({ queryKey: ["session", target] });
      void refreshSessionLists(qc).catch(() => undefined);
      return true;
    } catch (err) {
      toast(`Not sent: ${(err as Error).message}`, "danger");
      return false;
    }
  };
  return (
    <SmartScope session={sid} reply={d.excluded ? null : smartReply} liveDecision={liveDecision}>
      {!compact && !d.excluded && tasksSlot && areaWork.length
        ? createPortal(
            <section aria-labelledby={workId} className="mb-3 space-y-2" data-testid="coordinator-thread-work">
              <SectionHeader id={workId} label="This conversation" count={areaWork.length} />
              {areaWork.map((work) => (
                <ExecCard
                  key={`${sid}:${work.record.key}`}
                  work={work}
                  events={tracked.data?.events}
                  pending={control.isPending}
                  onControl={(input) => control.mutateAsync(input)}
                  onCompose={(next) => {
                    onShowChat?.();
                    setScope(next);
                    requestAnimationFrame(() => composer.current?.focus());
                  }}
                />
              ))}
            </section>,
            tasksSlot,
          )
        : null}
      <div
        ref={bodyRef}
        className={compact ? "gc-thread-body" : "co-body"}
        data-testid={compact ? "gc-thread-body" : "coordinator-body"}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {d.excluded ? (
          <p className="text-sm" data-testid="coordinator-excluded">
            Areas excluded from AI are never sent: this area has no coordinator chat.
          </p>
        ) : (
          <>
            <div className="gc-threadrow">
              <ThreadBar
                areaId={d.area.id}
                current={d.sessionId}
                viewing={sid}
                viewingTitle={detail.data?.session?.title ?? null}
                fresh={fresh}
                busy={send.isPending || control.isPending}
                pinned={!!d.pinned}
                onOpen={openThread}
                onNew={() => {
                  if (attachments.drafts.length) attachments.clear();
                  setChips([]);
                  dropScope();
                  setSessionId(null);
                  setFresh(true);
                  requestAnimationFrame(() => composer.current?.focus());
                }}
                onUndoNew={() => {
                  dropScope();
                  setFresh(false);
                  setSessionId(null);
                }}
              />
              {sid ? (
                <span className="relative inline-flex shrink-0">
                  <IconButton
                    label="In this chat"
                    icon={<PanelIcon className="h-4 w-4" />}
                    onClick={() => openThings(chat.things.line.state !== "quiet" ? chat.things.line.tab : "Running")}
                    data-testid="gc-things"
                  />
                  {chat.things.line.dot ? (
                    <span aria-hidden="true" className="chat-attention-dot absolute top-1 right-1" data-dot={chat.things.line.dot} />
                  ) : null}
                </span>
              ) : null}
            </div>
            {!sid ? earlierThreads : null}
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
              <MarkdownRefRenderer.Provider value={refChip}>
                {hiddenGroups > 0 ? (
                  <Button size="sm" variant="ghost" className="gc-load-earlier" data-testid="gc-load-earlier" onClick={loadEarlier}>
                    Load earlier ({hiddenGroups})
                  </Button>
                ) : (
                  earlierThreads
                )}
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
                        <li className="co-msg" data-msg={m.id}>
                          <BackgroundNotices messages={messageGroups[index]} />
                        </li>
                      ) : m.kind === "assistant" ? (
                        <li key={m.id} className="co-msg" data-who="assistant" data-msg={m.id}>
                          {toolRuns.has(m.id) ? (
                            <div className="gc-toolwork" data-testid="gc-toolwork">
                              <ToolGroup group={toolRuns.get(m.id)!} />
                            </div>
                          ) : null}
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

                          <AssistantText text={m.text} messageId={m.id} />
                          <ActionsTaken actions={actionsFor(m.id)} sessionId={sid ?? undefined} areaHint={d.area.title} compact />
                          {mentions ? <MentionRows refs={mentionRows(m.id)} render={mentions.render} /> : null}
                        </li>
                      ) : (
                        <li key={m.id} className="co-msg" data-who="user" data-msg={m.id}>
                          <UserMessage text={m.text} sessionId={sid} onRef={onRef ? jumpTo : undefined} />
                        </li>
                      )}
                    </Fragment>
                  ))}
                </ol>
              </MarkdownRefRenderer.Provider>
            ) : sid && detail.isSuccess ? (
              <p className="text-sm text-muted">No messages yet.</p>
            ) : null}

            {trailingTools ? <ToolGroup group={trailingTools} /> : null}
            {showLive ? (
              <MarkdownRefRenderer.Provider value={refChip}>
                <AssistantName.Provider value={name}>
                  <div className="gc-live" data-testid="gc-live">
                    <LiveRun state={run.state} onApprove={answerApproval} onClarify={answerClarify} onRetry={run.retry} />
                  </div>
                </AssistantName.Provider>
              </MarkdownRefRenderer.Provider>
            ) : null}
            {detail.data?.session?.activeRun ? (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                <Dot tone="ai" live label="Coordinator running" />
                <span className="text-muted">{compact ? `${name} is working…` : "Working…"}</span>
                <Button size="sm" variant="ghost" loading={stop.isPending} onClick={() => stop.mutate()}>
                  Stop
                </Button>
                {compact ? null : (
                  <Link className="inline-flex min-h-11 items-center px-2 text-accent sm:min-h-10" href={`/chat/${encodeURIComponent(sid!)}`}>
                    Open
                  </Link>
                )}
              </div>
            ) : null}
            <ActionsTaken actions={actionsFor("live")} sessionId={sid ?? undefined} areaHint={d.area.title} compact />
            {sourceDown ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                {execution.error ? "Couldn't load coordinator runs." : "Couldn't check every source of background work."}{" "}
                <Button size="sm" variant="ghost" loading={execution.isFetching} onClick={() => void execution.refetch()}>
                  Try again
                </Button>
              </p>
            ) : null}

            {sid && !compact ? (
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
        <div className={compact ? "gc-composer" : "co-foot"}>
          <Composer
            ref={composer}
            surface="panel"
            sessionId={sid}
            text={text}
            onText={setText}
            answerer="the coordinator"
            // With a chip the words are about that thing, whatever is running; with none they are guidance for the run.
            label={scope || !running ? "Message the coordinator" : undefined}
            keyPrefix="coord"
            canSend={canSend}
            placeholder={
              scope
                ? scopePlaceholder(scope)
                : running
                  ? undefined
                  : compact
                    ? `Ask ${name === "Coordinator" ? "the coordinator" : "your " + name.toLowerCase()}…`
                    : "Ask the coordinator…"
            }
            // A run in flight takes the words as guidance, as on the chat page. Stop stays on the run's own row, where
            // it asks first.
            // What the composer needs to know about the run: it is waiting on an approval, it is stopping, or it is
            // simply going. A stream that is queued or reconnecting does not stop guidance or a chip from being sent.
            phase={!running ? undefined : run.state.phase === "waiting_for_approval" || run.state.phase === "stopping" ? run.state.phase : "running"}
            clarifying={run.active && !!run.state.clarify}
            online={online}
            // The status bar every chat has: one line for what is happening, then counts. A tap opens "In this chat".
            tray={
              sid ? (
                <ChatTray
                  things={chat.things}
                  onOpen={openThings}
                  onRetry={chat.retry}
                  compact={run.state.phase === "waiting_for_approval" || (run.active && !!run.state.clarify)}
                />
              ) : undefined
            }
            onStop={() => stop.mutate()}
            modelLabel={chosen.model ?? "Default"}
            onModel={sid ? () => setModelOpen(true) : undefined}
            accessory={
              compact && (text.trim() || scope) ? null : (
                <QuickActionChips variant="row" context={quickContext ?? { areaId: d.area.id, areaTitle: d.area.title, path: pathname }} onPrompt={fill} />
              )
            }
            lead={
              compact && context ? (
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
              ) : compact && !standalone ? (
                <p className="gc-hint gc-context-none">No page context is shared.</p>
              ) : null
            }
            scope={
              scope ? (
                <>
                  {/* What the next message is about. Remove it (or Backspace in the empty field) to write an ordinary message. */}
                  <div
                    className="gc-scope"
                    role="group"
                    aria-label={scopeLabel(scope)}
                    data-kind={scope.ref?.startsWith("D-") ? "d" : "r"}
                    data-testid="gc-scope"
                  >
                    <span className="k-ref" data-kind={scope.ref?.startsWith("D-") ? "d" : "r"}>
                      {scopeChip(scope)}
                    </span>
                    <span className="gc-scope-title">{scope.title}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="×"
                      aria-label={`Remove ${scopeChip(scope)} from the message`}
                      onClick={() => setScope(null)}
                    >
                      Remove
                    </Button>
                  </div>
                  {confirming ? (
                    <p className="gc-scope-confirm" role="status">
                      <span>{scope.ref} is flagged risky. Send again to record this as your answer.</span>
                      <Button variant="ghost" size="sm" onClick={() => setArmed(null)}>
                        Cancel
                      </Button>
                    </p>
                  ) : null}
                </>
              ) : null
            }
            footer={
              compact ? (
                <>
                  {!online ? (
                    <p className="gc-hint" role="status" data-tone="warn">
                      You&apos;re offline. Your draft is kept; send it when you&apos;re back.
                    </p>
                  ) : null}
                  <p className="gc-hint gc-keys">@ context · # PR · Ctrl/⌘+Enter to send</p>
                </>
              ) : (
                <div className="co-foot-row flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={!d.prompt}
                    onClick={() => d.prompt && setText(d.prompt)}
                    data-testid="coordinator-catch-up"
                    title="Fills the message with a summary of this area's open items, decisions and recent activity. Nothing is sent until you tap Send."
                  >
                    Catch me up
                  </Button>
                  <span className="min-w-0 flex-1 text-xs text-muted">{text ? "Review, then tap Send." : null}</span>
                </div>
              )
            }
            context={chips.map((c) => ({ label: c.label, ref: c.ref }))}
            onRemoveContext={(ref) => setChips((all) => all.filter((x) => x.ref !== ref))}
            onAttach={() => setSheet(true)}
            attachments={{ ...attachments, add: attach }}
            onSend={deliver}
            onSteer={deliver}
            // Commands that act on a conversation page (fork, file, share…) have nothing to act on here.
            onCommand={(id) => (id === "context" ? setSheet(true) : id === "model" && sid ? setModelOpen(true) : undefined)}
            commands={PANEL_COMMANDS}
            repo={null}
            sendsEmpty={!!scope && scopeSendsEmpty(scope)}
            onEmptyBackspace={scope ? () => setScope(null) : undefined}
            sendLabel={confirming ? "Confirm answer" : undefined}
            sending={send.isPending || control.isPending || answering}
            // One primary action per view: while proposals are waiting, theirs is it.
            quietSend={!compact && hasProposals}
            testIds={{
              input: compact ? "gc-input" : "coordinator-input",
              send: "coordinator-send",
              add: "gc-add",
              file: "gc-file-input",
              camera: "gc-camera-input",
              library: "gc-library-input",
            }}
          />
        </div>
      ) : null}
      {sid && things ? (
        <ChatPanel
          sessionId={sid}
          open
          wide={false}
          tab={things}
          onTab={openThings}
          onClose={() => setThings(null)}
          things={chat.things}
          links={panel.links}
          context={chips}
          readOnly={false}
          onPatch={panel.patch}
          onRemoveContext={(ref) => setChips((all) => all.filter((x) => x.ref !== ref))}
          execution={known}
          executionError={chat.error}
          executionLoading={chat.loading}
          retry={chat.retry}
          onAddContext={() => {
            setThings(null);
            setSheet(true);
          }}
        />
      ) : null}
      {sid && modelOpen ? (
        <ModelSelectDialog
          open
          onClose={() => setModelOpen(false)}
          backend={detail.data?.session?.source === "claude" ? "claude" : "hermes"}
          value={chosen}
          onChange={(m) => {
            setModel({ sid, ...m });
            void kvSet(`model:${sid}`, m);
          }}
          area={null}
        />
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
    </SmartScope>
  );
}

/** What the owner sent: their words in a bubble; machine wrappers become a quiet caption or a compact receipt. */
// The address's fragment, read as the thread renders. Next's own navigations change it without a hashchange event,
// but they re-render the thread (it becomes the page), which is when it is read.
const subscribeHash = (changed: () => void) => {
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  return () => {
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("popstate", changed);
  };
};
const readHash = () => window.location.hash;
const noHash = () => "";
/** The message a "#msg-<id>" fragment names (lib/feedback.ts messageLink), or null. */
function linkedMessage(hash: string): string | null {
  if (!hash.startsWith("#msg-")) return null;
  try {
    return decodeURIComponent(hash.slice(5)) || null;
  } catch {
    return null; // a malformed fragment is not a message link
  }
}

function UserMessage({ text, sessionId, onRef }: { text: string; sessionId?: string | null; onRef?: (ref: string) => void }) {
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
        <p className={`whitespace-pre-wrap${long && !open ? " line-clamp-4" : ""}`}>{onRef ? withRefs(parts.text, onRef) : parts.text}</p>
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
/** The D-n / R-n references in a message's prose (code and link destinations are not mentions), in order, once each. */
function proseRefs(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|\]\([^)]*\)/g, " ");
  return [...new Set(refChips(prose).map((chip) => chip.ref))];
}
/** The owner's own words with any D-n / R-n in them as chips that jump to the thing. */
function withRefs(text: string, onRef: (ref: string) => void): ReactNode[] {
  return text
    .split(/\b([DR]-\d{1,9})\b/)
    .map((part, index) => (index % 2 ? <RefPill key={index} id={part} onClick={() => onRef(part)} className="gc-inline-ref" /> : part));
}
/** How many of a reply's mentioned things are drawn as rows before "N more". */
/** The `/` commands that make sense in the panel: the rest act on a conversation page. */
const PANEL_COMMANDS = ["context", "model"] as const;
const NO_ITEMS: TimelineItem[] = [];
const MENTIONS_SHOWN = 3;
/**
 * What a reply mentions, as rich rows right under it: three at most, the rest behind one line that names them.
 * The references themselves are chips in the reply's text; there is no separate list of mentions.
 */
function MentionRows({ refs, render }: { refs: string[]; render: (ref: string) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!refs.length) return null;
  const shown = all ? refs : refs.slice(0, MENTIONS_SHOWN);
  const rest = refs.slice(shown.length);
  return (
    <section aria-label="Mentioned in this reply" className="gc-bgwork gc-mention-rows">
      {shown.map((ref) => (
        <Fragment key={ref}>{render(ref)}</Fragment>
      ))}
      {refs.length > MENTIONS_SHOWN ? (
        <Button variant="ghost" size="sm" className="gc-mention-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : `${rest.length} more`}
          {all
            ? null
            : rest.map((ref) => (
                <span key={ref} className="k-ref" data-kind={ref.startsWith("D") ? "d" : "r"}>
                  {ref}
                </span>
              ))}
        </Button>
      ) : null}
    </section>
  );
}

/** Background work in the order the owner needs it. */
const SINCE_ICON: Record<SinceChip["key"], ReactNode> = {
  failed: <AlertIcon className="h-3.5 w-3.5" />,
  decisions: <InboxIcon className="h-3.5 w-3.5" />,
  waiting: <BellIcon className="h-3.5 w-3.5" />,
  stuck: <AlertIcon className="h-3.5 w-3.5" />,
  finished: <CheckIcon className="h-3.5 w-3.5" />,
  runs: <BoltIcon className="h-3.5 w-3.5" />,
};
