"use client";
import { refreshSessionLists } from "@/lib/client/session-lists";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { kvDel, kvGet, kvSet, rememberSession } from "@/lib/client/idb";
import { takeFirstRun } from "@/lib/client/first-run";
import type { EntityLink } from "@/lib/contracts";
import { isTerminal, type ApprovalRequest, type RunPhase, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { formatTime } from "@/components/actions/format";
import { Badge, Button, ErrorNote, OverflowMenu, Spinner, cx, useOnline, useToast, type Tone } from "@/components/ui";
import { BrainIcon, ChevronIcon, ForkIcon, PlusIcon, SendIcon, StopIcon } from "@/components/icons";
import { ToolStep } from "./ToolStep";
import { needsTimeDivider, unwrapBrokenLines } from "@/lib/chat-text";
import { useKeyboardInset } from "@/lib/client/keyboard";
import { useModKey } from "@/lib/client/platform";
import { composerKey, isSendShortcut, SEND_KEYSHORTCUTS, sendHint } from "@/lib/client/composer-keys";
import { quickAdd, useAgentCapture, useWorkflowRun } from "@/components/workflows/RunPanel";
import { useAccess } from "@/components/access";
import { useRunStream, type Activity, type RunState } from "./useRunStream";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { AssistantText, SmartSession } from "@/components/smart/AssistantText";
import { ForkDialog, RenameDialog, TrackDialog } from "./dialogs";
import { ContextSheet, type ContextChip } from "./ContextSheet";
import { usePanelLinks } from "./LinksPanel";
import { useFollowScroll } from "./useFollowScroll";
import { ChatPanel, ParentChatLink } from "./things/ChatPanel";
import { ChatTray } from "./things/ChatTray";
import { ChatLinkProvider } from "./things/ChatLinkProvider";
import { useChatThings } from "./things/useChatThings";
import { useChatPanelLayout } from "./things/useChatPanelLayout";
import type { ThingsTab } from "@/lib/chat/things";
import "./things/things.css";
import {
  AttachButton,
  AttachmentChips,
  CameraButton,
  DropOverlay,
  MessageAttachments,
  pastedFiles,
  useChatAttachments,
  useConversationFiles,
  useFileDrop,
  type ChatAttachments,
} from "./Attachments";
import { parseFileMarkers, type ChatFileView } from "@/lib/chat-files";
import { TriggerPopover, useTriggerRows, type PickerRow } from "./ComposerPicker";
import { useAskHermes } from "./useAskHermes";
import { WorkSummary, formatStepSec } from "./WorkSummary";
import { ModelSelectDialog } from "@/components/areas/ModelPicker";
import { FileUnderDialog } from "@/components/work/conversations";
import { displayRef, encodeMessage, splitReferences, triggerAt, type CommandId, type Reference, type Trigger } from "@/lib/references";
import type { AreaSettings, FilingSuggestion, ConversationPlacement, ItemsResponse } from "@/lib/work";
import type { AgentResolution } from "@/lib/agents";
import { AgentChip } from "@/components/agents/AgentChip";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { ClarifyCard } from "@/components/approvals/ClarifyCard";
import { CompactionDivider, NoticeCard } from "./Notice";
import { parseNotice } from "@/lib/chat-notices";

/** GET /api/hermes/sessions/:id/area */
type AreaContext =
  | { enabled: false }
  | {
      enabled: true;
      placement: ConversationPlacement | null;
      node: { id: string; status: string } | null;
      suggestions: FilingSuggestion[];
      area: { id: string; title: string; builtIn: boolean } | null;
      settings: AreaSettings | null;
      agent?: AgentResolution | null;
    };

const CONTEXT_MARK = "\n\n---\nContext from Jarvis:";
const NO_FILES: ChatFileView[] = [];
/** Sent attachments of this conversation, for message bubbles. */
const ChatFiles = createContext<{ sessionId: string; files: ChatFileView[] }>({ sessionId: "", files: NO_FILES });

type Detail = {
  session: SessionSummary;
  timeline: TimelineItem[];
  parent?: SessionSummary;
  children: SessionSummary[];
  links: EntityLink[];
};

const PHASE_LABEL: Record<RunPhase, { label: string; tone: Tone }> = {
  starting: { label: "Starting…", tone: "accent" },
  queued: { label: "Queued", tone: "accent" },
  running: { label: "Working…", tone: "accent" },
  waiting_for_approval: { label: "Needs your approval", tone: "warn" },
  stopping: { label: "Stopping…", tone: "warn" },
  completed: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Stopped", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "danger" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  disconnected: { label: "Disconnected", tone: "danger" },
};

/** "Hermes" or "Claude": who answers this conversation. */
const AssistantName = createContext("Hermes");

function useSessionDetail(sessionId: string) {
  const [offline, setOffline] = useState<Detail>();
  const q = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      const d = await api.get<Detail>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}`);
      rememberSession(sessionId, d);
      return d;
    },
  });
  useEffect(() => {
    kvGet<{ data: Detail; savedAt: string }>(`session:${sessionId}`).then((s) => s && setOffline(s.data));
  }, [sessionId]);
  return { ...q, detail: q.data ?? offline, fromCache: !q.data && Boolean(offline) };
}

const NO_TIMELINE: TimelineItem[] = [];

export function Conversation({ sessionId, initialRunId }: { sessionId: string; initialRunId?: string }) {
  const qc = useQueryClient();
  const online = useOnline();
  const { toast, announce } = useToast();
  const { can } = useAccess();
  const { detail, error, refetch, fromCache, isLoading, isFetching } = useSessionDetail(sessionId);
  const [pendingInput, setPendingInput] = useState<string>();
  /** A first message that failed to send goes back into the mounted composer. */
  const [restore, setRestore] = useState<{ text: string; key: string; at: number }>();
  const [dialog, setDialog] = useState<null | "rename" | "fork" | "track" | "model" | "context" | "file">(null);
  const router = useRouter();
  const newChat = useAskHermes();
  const [forkFrom, setForkFrom] = useState<TimelineItem>();
  const [model, setModel] = useState<{ model?: string; provider?: string }>({});
  const [context, setContext] = useState<ContextChip[]>([]);
  const [lastOutcome, setLastOutcome] = useState<RunPhase>();
  const clearRunRef = useRef<() => void>(() => {});
  const who = detail?.session.source === "claude" ? "Claude" : "Hermes";
  const canAreas = can("work.use");
  const areaQ = useQuery({
    queryKey: ["work", "conversation-area", sessionId, detail?.session.title ?? ""],
    queryFn: () => api.get<AreaContext>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/area?title=${encodeURIComponent(detail?.session.title ?? "")}`),
    enabled: canAreas && !!detail && !detail.session.readOnly,
  });
  const areaCtx = areaQ.data?.enabled ? areaQ.data : null;
  const panel = usePanelLinks(sessionId, detail?.timeline ?? NO_TIMELINE, Boolean(detail?.session.readOnly) || !detail);
  const attachments = useChatAttachments(sessionId);
  const drop = useFileDrop(attachments.add, Boolean(detail) && !detail?.session.readOnly);
  const filesQ = useConversationFiles(sessionId);
  const removeContext = (ref: string) => setContext((c) => c.filter((x) => x.ref !== ref));
  const treeItems = useQuery({
    queryKey: ["work", "items", false],
    queryFn: () => api.get<ItemsResponse>("/api/work/items"),
    enabled: dialog === "file",
  });

  const onTerminal = useCallback(
    (s: RunState) => {
      announce(s.phase === "completed" ? `${who} finished responding` : `Run ${PHASE_LABEL[s.phase].label.toLowerCase()}`);
      setLastOutcome(s.phase);
      refreshSessionLists(qc);
      qc.invalidateQueries({ queryKey: ["home"] });
      // Once the durable transcript includes this turn, drop the live copy (keeps failure notices).
      qc.refetchQueries({ queryKey: ["session", sessionId] }).then(() => {
        setPendingInput(undefined);
        if (s.phase === "completed") clearRunRef.current();
      });
    },
    [announce, qc, sessionId, who],
  );
  const run = useRunStream(onTerminal);
  useEffect(() => {
    clearRunRef.current = run.clear;
  });

  // Resume an active run (after refresh/navigation) or one passed in the URL.
  const resumed = useRef<string | null>(null);
  useEffect(() => {
    const active = detail?.session.activeRun?.runId ?? initialRunId;
    if (active && resumed.current !== active && run.state.runId !== active) {
      resumed.current = active;
      const phase = detail?.session.activeRun?.status;
      run.start(active, phase === "queued" ? "queued" : phase === "waiting_for_approval" ? "waiting_for_approval" : "running");
      void kvGet<{ runId: string; input: string }>(`accepted:${sessionId}`).then((saved) => {
        if (saved?.runId === active && resumed.current === active) setPendingInput(saved.input);
      });
    }
  }, [detail?.session.activeRun?.runId, detail?.session.activeRun?.status, initialRunId, run, sessionId]);

  useEffect(() => {
    kvGet<{ model?: string; provider?: string }>(`model:${sessionId}`).then((m) => m && setModel(m));
  }, [sessionId]);

  // "Ask" opened this conversation before its first message was sent: show it now, stream when the run starts.
  const firstRun = useRef<string | null>(null);
  const retryContext = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (firstRun.current === sessionId) return;
    firstRun.current = sessionId;
    const first = takeFirstRun(sessionId);
    if (!first) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the consumed first-run handoff once
    setPendingInput(first.input);
    first.run.then(
      (r) => {
        void kvSet(`accepted:${sessionId}`, { runId: r.runId, input: first.input });
        // The resume effect may already have picked this run up from a detail refetch.
        if (resumed.current !== r.runId) {
          resumed.current = r.runId;
          run.start(r.runId, r.status);
        }
        refreshSessionLists(qc);
      },
      (err) => {
        setPendingInput(undefined);
        void kvSet(`draft:${sessionId}`, first.input);
        // #44: the retry keeps the context the global composer attached (e.g. the area).
        retryContext.current = first.context;
        setRestore({ text: first.input, key: first.key, at: Date.now() });
        toast(`Not sent: ${(err as Error).message} Your message is saved as a draft.`, "danger");
      },
    );
  }, [sessionId, run, qc, toast]);

  useEffect(() => {
    if (run.state.phase === "waiting_for_approval") announce("Hermes needs your approval");
  }, [run.state.phase, announce]);
  const clarifyId = run.state.clarify?.requestId;
  useEffect(() => {
    if (clarifyId) announce("Hermes has a question for you");
  }, [clarifyId, announce]);

  const session = detail?.session;
  const wfRun = useWorkflowRun(sessionId);
  const [wfTarget, setWfTarget] = useState<string | null>(null);
  const chatWrapperRef = useRef<HTMLDivElement>(null);
  const surface = useChatPanelLayout(sessionId, chatWrapperRef, !!detail, !!wfRun);
  const workflowSections = (wfRun?.panel.find((e) => e.type === "Outline")?.props.sections ?? []) as { title: string; bind: string }[];
  const workflowChips = (wfRun?.panel.find((e) => e.type === "QuickAddChips")?.props.chips ?? []) as { label: string; field: string }[];
  const chatThings = useChatThings(sessionId, {
    links: panel.links,
    pending: { approval: !!run.state.approval, clarify: !!run.state.clarify && run.active },
    parentRunning: run.active,
    parentFailed: run.state.phase === "failed" || run.state.phase === "interrupted",
    filesCount: filesQ.data ? filesQ.data.filter((f) => f.sentAt).length : null,
    contextPercent: null,
    workflow:
      wfRun?.status === "live"
        ? {
            title: wfRun.title,
            step: wfTarget ? `Next note: ${workflowChips.find((c) => c.field === wfTarget)?.label ?? wfTarget}` : wfRun.title,
            sections: workflowSections.map((s) => ({
              title: s.title,
              count: Array.isArray(wfRun.capture[s.bind]) ? (wfRun.capture[s.bind] as unknown[]).length : 0,
            })),
          }
        : null,
  });
  const openPanel = (tab: ThingsTab) => {
    surface.show(tab);
    chatThings.markSeen(tab);
  };
  const onCaptured = useCallback(
    (r: { applied: string[]; dropped: number; proposed: number }) => {
      if (r.dropped) toast(r.dropped === 1 ? "1 note not filed" : `${r.dropped} notes not filed`, "warn");
      else if (r.applied.length) announce(`Outline updated: ${r.applied.length} ${r.applied.length === 1 ? "change" : "changes"}. Undo is available.`);
    },
    [toast, announce],
  );
  const capture = useAgentCapture(sessionId, wfRun, detail?.timeline ?? NO_TIMELINE, onCaptured);

  const send = async (input: string, key: string) => {
    let text = input;
    if (wfRun && wfRun.status === "live" && wfTarget) {
      const target = wfTarget;
      setWfTarget(null);
      void quickAdd(wfRun, target, input)
        .then((r) => {
          qc.setQueryData(["workflow-run", sessionId], r.run);
          // a rejected note (wrong shape, list full) was silently cleared before (#135)
          if (r.dropped && !r.applied.length) toast(`That note didn't fit ${target}, so it wasn't added to the outline.`, "danger");
        })
        .catch((e: Error) => toast(e.message, "danger"));
      text = `[${target}] ${input}`;
    }
    const ctx = [
      context
        .filter((c) => !c.token)
        .map((c) => `- ${c.label} [${c.ref}]`)
        .join("\n"),
      wfRun?.status === "live" ? (wfRun.context ?? "") : "",
      retryContext.current ?? "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4000);
    // Sheet picks that are @/# references ride in the message as tokens: the server resolves them like typed ones.
    const tokens = context.filter((c) => c.token && !text.includes(c.token)).map((c) => c.token);
    if (tokens.length) text = `${text}\n\n${tokens.join(" ")}`;
    setPendingInput(text);
    await kvSet(`pending:${sessionId}`, { input: text, key });
    try {
      const r = await api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/runs`, {
        input: text,
        idempotencyKey: key,
        context: ctx || undefined,
        files: attachments.readyIds.length ? attachments.readyIds : undefined,
        capabilities: [SMART_CAPABILITY],
        ...model,
      });
      await kvDel(`pending:${sessionId}`);
      await kvSet(`accepted:${sessionId}`, { runId: r.runId, input: text });
      retryContext.current = undefined;
      setContext([]);
      if (attachments.drafts.length) {
        attachments.clear();
        void qc.invalidateQueries({ queryKey: ["chat-files", sessionId] });
      }
      announce(r.status === "queued" ? "Message queued. Waiting for an available agent slot." : `Message sent. ${who} is responding.`);
      resumed.current = r.runId;
      run.start(r.runId, r.status);
      refreshSessionLists(qc);
      return true;
    } catch (err) {
      setPendingInput(undefined);
      toast(err instanceof ApiError && err.code === "network" ? "Not sent — check your connection. Your draft is kept." : (err as Error).message, "danger");
      return false;
    }
  };

  const steer = async (text: string) => {
    if (!run.state.runId) return false;
    try {
      await api.post(`/api/hermes/runs/${encodeURIComponent(run.state.runId)}/steer`, { input: text });
      toast("Guidance queued for Hermes", "ok");
      return true;
    } catch (err) {
      toast((err as Error).message, "danger");
      return false;
    }
  };

  const answerApproval = async (choice: ApprovalRequest["choices"][number]) => {
    if (!run.state.runId) return;
    try {
      await api.post(`/api/hermes/runs/${encodeURIComponent(run.state.runId)}/approval`, { choice, requestId: run.state.approval?.requestId });
      announce(choice === "deny" ? "Denied" : "Approved");
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (err) {
      // The approval card shows "Couldn't send your approval" + Retry, with this message folded under Details.
      announce(choice === "deny" ? "Couldn't send your denial" : "Couldn't send your approval");
      throw err;
    }
  };

  const answerClarify = async (answer: string) => {
    const runId = run.state.runId;
    const requestId = run.state.clarify?.requestId;
    if (!runId || !requestId) return;
    try {
      await api.post(`/api/hermes/runs/${encodeURIComponent(runId)}/clarify`, { answer, requestId });
      announce("Answer sent");
    } catch (err) {
      announce("Couldn't send your answer");
      throw err;
    }
  };

  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api.patch(`/api/hermes/sessions/${encodeURIComponent(sessionId)}`, body);
      qc.invalidateQueries({ queryKey: ["session", sessionId] });
      refreshSessionLists(qc);
      toast(msg, "ok");
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };

  const fileTo = async (itemId: string | null, title?: string) => {
    try {
      await api.post("/api/work/conversations/file", { sessionId, itemId });
      qc.invalidateQueries({ queryKey: ["work"] });
      toast(title ? `Filed under ${title}` : "Filed", "ok");
      return true;
    } catch (err) {
      toast((err as Error).message, "danger");
      return false;
    }
  };

  /** `/` commands from the composer (each is also reachable from the menu or the header). */
  const runCommand = (id: CommandId) => {
    const itemFor = areaCtx?.node?.id ?? areaCtx?.placement?.parentId ?? null;
    switch (id) {
      case "model":
        return setDialog("model");
      case "context":
        return setDialog("context");
      case "fork":
        setForkFrom(undefined);
        return setDialog("fork");
      case "file":
        return canAreas ? setDialog("file") : toast("Filing needs Areas.", "neutral");
      case "share":
        return patch({ shared: !session?.shared }, session?.shared ? "Only you can see this conversation now" : "Shared with the household (read-only)");
      case "new":
        return void newChat.start({ areaId: areaCtx?.placement?.parentId ?? null });
      case "mode":
        return void newChat.start({ backend: session?.source === "claude" ? "hermes" : "claude", areaId: areaCtx?.placement?.parentId ?? null });
      case "handoff":
      case "settle":
        if (!itemFor) return toast("File this conversation first (/file), then hand off or settle it.", "neutral");
        return router.push(`/areas?item=${encodeURIComponent(itemFor)}&do=${id === "handoff" ? "continue" : "settle"}`);
    }
  };

  // --- scrolling: follow the latest output until the person scrolls up (useFollowScroll) ---
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const { detached, jumpToLatest } = useFollowScroll(threadRef, bottomRef, Boolean(detail));
  // Keyboard open (phones): the bottom bar hides and the composer sits right above the keyboard; jump to the latest message.
  const toLatest = useCallback(() => {
    setTimeout(() => jumpToLatest(), 60);
  }, [jumpToLatest]);
  const onKeyboard = useCallback((open: boolean) => (open ? toLatest() : undefined), [toLatest]);
  useKeyboardInset(onKeyboard);

  // C4: opening a conversation (and every new message while it's open) marks it read for you.
  const lastItemId = detail?.timeline.at(-1)?.id ?? null;
  const readCount = detail?.session.messageCount ?? null;
  // Only the transcript actually shown and freshly fetched counts: a cached detail (or a failed refresh)
  // may predate new messages, and marking it read would hide them.
  const readKey = detail && !fromCache && !isFetching && !error ? `${sessionId}:${readCount}:${lastItemId}` : null;
  const lastRead = useRef<string | null>(null);
  useEffect(() => {
    if (!readKey || !online || lastRead.current === readKey) return;
    lastRead.current = readKey;
    api
      .post("/api/work/conversations/read", { sessionId, messageCount: readCount, lastMessageId: lastItemId })
      .then(() => qc.invalidateQueries({ queryKey: ["work", "conversations", "view"] }))
      .catch(() => {
        lastRead.current = null;
      });
  }, [readKey, online, sessionId, readCount, lastItemId, qc]);

  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {error ? <ErrorNote error={error} retry={() => refetch()} /> : isLoading ? <Spinner label="Loading conversation…" /> : null}
      </div>
    );
  }

  const phase = run.state.runId ? run.state.phase : lastOutcome;
  const liveActive = run.active;
  // A completed run's reply can land in the refetched transcript one render before the live copy is
  // cleared (onTerminal's refetch → clear); don't show the same reply twice in that window.
  const liveText = (run.state.text || run.state.output || "").trim();
  const lastAssistant = [...detail.timeline].reverse().find((t) => t.kind === "assistant");
  const liveInTranscript =
    run.state.phase === "completed" && Boolean(liveText) && Boolean(lastAssistant && "text" in lastAssistant && lastAssistant.text.trim() === liveText);
  const showLive =
    Boolean(run.state.runId) &&
    !liveInTranscript &&
    (liveActive || run.state.phase !== "completed" || Boolean(run.state.text) || run.state.activity.length > 0);
  const lastUser = [...detail.timeline].reverse().find((t) => t.kind === "user");
  const showPendingUser = pendingInput && !(lastUser && "text" in lastUser && lastUser.text.startsWith(pendingInput.slice(0, 40)));

  const readOnly = Boolean(session!.readOnly);
  // Time dividers: shown before the first message and after gaps over 5 minutes (per-message times are on tap).
  const dividerIds = timeDividerIds(detail.timeline);
  const fork = { label: "Fork latest state", onSelect: () => (setForkFrom(undefined), setDialog("fork")), disabled: !online };
  const menu = readOnly
    ? [fork]
    : [
        { label: "Rename", onSelect: () => setDialog("rename") },
        fork,
        { label: "Model…", onSelect: () => setDialog("model") },
        ...(canAreas ? [{ label: "File under…", onSelect: () => setDialog("file") }] : []),
        ...(areaCtx?.node ? [{ label: "Properties", onSelect: () => router.push(`/areas?item=${encodeURIComponent(areaCtx.node!.id)}`) }] : []),
        ...(canAreas && can("work.ai")
          ? [{ label: "Save chat as workflow", onSelect: () => router.push(`/workflows/new?fromChat=${encodeURIComponent(sessionId)}`), disabled: !online }]
          : []),
        ...(can("paperclip.track") ? [{ label: "Track in Paperclip", onSelect: () => setDialog("track"), disabled: !online }] : []),
        {
          label: session!.pinned ? "Unpin" : "Pin",
          onSelect: () => patch({ pinned: !session!.pinned }, session!.pinned ? "Unpinned" : "Pinned"),
          disabled: !online,
        },
        {
          label: session!.shared ? "Stop sharing with the household" : "Share with the household",
          onSelect: () =>
            patch(
              { shared: !session!.shared },
              session!.shared ? "Only you can see this conversation now" : `Shared: others who use ${who} can read and fork it`,
            ),
          disabled: !online,
        },
        {
          label: session!.archived ? "Unarchive" : "Archive",
          onSelect: () => patch({ archived: !session!.archived }, session!.archived ? "Restored" : "Archived"),
          disabled: !online,
        },
      ];
  // C1: a read-only summary + link for pasting elsewhere. Nothing is published or sent: it only goes to your clipboard.
  menu.push({
    label: "Share summary…",
    onSelect: () => {
      const text = shareSummary({
        title: session!.title,
        agent: areaCtx?.agent?.profile ?? session!.agentProfile ?? null,
        assistant: who,
        path: areaCtx?.placement?.path ?? null,
        timeline: detail.timeline,
        url: window.location.origin + `/chat/${encodeURIComponent(sessionId)}`,
      });
      (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"))).then(
        () => toast("Summary copied", "ok"),
        () => toast("Couldn't copy to the clipboard", "danger"),
      );
    },
  });
  menu.push({
    label: "Copy link",
    onSelect: () => {
      navigator.clipboard?.writeText(window.location.origin + `/chat/${encodeURIComponent(sessionId)}`).then(() => toast("Link copied", "ok"));
    },
  });

  return (
    <AssistantName.Provider value={who}>
      <SmartSession.Provider value={sessionId}>
        <ChatFiles.Provider value={{ sessionId, files: filesQ.data ?? NO_FILES }}>
          <ChatLinkProvider links={panel.links}>
            <div ref={chatWrapperRef} className="chat-things-container @container" data-panel-open={(surface.wide && surface.open) || undefined}>
              <div className="chat-things-layout">
                <div className="chat-page relative mx-auto flex w-full max-w-[880px] min-w-0 flex-1 flex-col" data-testid="conversation-drop" {...drop.props}>
                  <DropOverlay show={drop.over} />
                  <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-3 py-1.5 backdrop-blur sm:px-6 sm:py-2.5">
                    <div className="flex items-center gap-1.5 sm:items-start sm:gap-2">
                      <Link
                        href="/chat"
                        className="tap -ml-2 inline-flex items-center justify-center rounded-xl text-muted lg:hidden"
                        aria-label="Back to conversations"
                      >
                        <ChevronIcon className="h-5 w-5 rotate-180" />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <h1 className="truncate text-[0.9375rem] leading-5 font-semibold tracking-[-0.01em] sm:text-[1.0625rem] sm:leading-6">
                          {session!.title}
                        </h1>
                        <ParentChatLink parent={chatThings.execution?.parent} />
                        {/* One line of context chips: phones scroll it sideways instead of stacking three rows. */}
                        <div
                          data-scroll-x
                          className="chat-head-chips scroll-x-clean mt-0.5 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted sm:flex-wrap"
                        >
                          {/* Opaque surface under the translucent tone: the desktop header is surface-2, where ok/warn tints drop below 4.5:1. */}
                          {phase ? (
                            <span className="inline-flex shrink-0 rounded-full bg-surface">
                              <Badge tone={PHASE_LABEL[phase].tone}>{PHASE_LABEL[phase].label}</Badge>
                            </span>
                          ) : null}
                          {session!.source === "claude" ? <Badge tone="accent">Claude · {session!.model}</Badge> : null}
                          {/* C1: agent mark — which Hermes profile answers here. */}
                          {areaCtx?.agent?.profile || session!.agentProfile ? (
                            <span
                              className="chip shrink-0 font-medium"
                              data-tone="accent"
                              data-testid="agent-badge"
                              title="The agent that answers this conversation"
                            >
                              @{areaCtx?.agent?.profile ?? session!.agentProfile}
                            </span>
                          ) : null}
                          {readOnly ? (
                            <Badge>Shared with you · read only</Badge>
                          ) : session!.shared ? (
                            <span className="chip" data-tone="accent" data-testid="shared-chip">
                              Shared with household ·
                              <button
                                type="button"
                                className="underline underline-offset-2"
                                disabled={!online}
                                onClick={() => patch({ shared: false }, "Only you can see this conversation now")}
                              >
                                Stop sharing
                              </button>
                            </span>
                          ) : null}
                          {areaCtx ? (
                            <span className="inline-flex shrink-0 items-center gap-1" data-testid="area-chip">
                              {/* C1: the area path reads as a breadcrumb (tap to file elsewhere), not another chip. */}
                              <button
                                type="button"
                                className="inline-flex max-w-[32ch] min-w-0 cursor-pointer items-center gap-0.5 rounded-[6px] px-1 text-muted hover:bg-surface-2 hover:text-text"
                                title={areaCtx.placement?.path ?? "Not in Areas yet"}
                                onClick={() => setDialog("file")}
                                aria-label={`In ${areaCtx.placement?.path || "no area"}. File elsewhere`}
                              >
                                <span className="truncate">{areaCtx.placement?.path || "Not in Areas"}</span>
                                <ChevronIcon className="h-3 w-3 shrink-0 rotate-90" />
                              </button>
                              {areaCtx.suggestions.slice(0, 2).map((sg) => (
                                <button
                                  key={sg.id}
                                  type="button"
                                  className="chip cursor-pointer"
                                  data-tone="accent"
                                  title={`${sg.path} — shares: ${sg.matched.join(", ")}`}
                                  onClick={() => fileTo(sg.id, sg.title)}
                                >
                                  File under {sg.title}
                                </button>
                              ))}
                              {/* Properties lives in the header ⋯ menu. */}
                            </span>
                          ) : null}
                          {session!.endReason === "branched" ? <span>Forked (transcript unchanged)</span> : null}
                          {detail.parent ? (
                            <span className="inline-flex items-center gap-1">
                              <ForkIcon className="h-3.5 w-3.5" /> Forked from{" "}
                              <Link className="underline" href={`/chat/${encodeURIComponent(detail.parent.id)}`}>
                                {detail.parent.title}
                              </Link>
                            </span>
                          ) : session!.parentSessionId ? (
                            <Link className="inline-flex items-center gap-1 underline" href={`/chat/${encodeURIComponent(session!.parentSessionId)}`}>
                              <ForkIcon className="h-3.5 w-3.5" /> Forked from parent
                            </Link>
                          ) : null}
                          {detail.children.length ? (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              <ForkIcon className="h-3.5 w-3.5" /> Forks:
                              {detail.children.map((c) => (
                                <Link key={c.id} className="underline" href={`/chat/${encodeURIComponent(c.id)}`}>
                                  {c.title}
                                </Link>
                              ))}
                            </span>
                          ) : null}
                          {[...new Map(detail.links.map((l) => [l.targetId, l])).values()].map((l) => (
                            <Link
                              key={l.targetId}
                              href="/initiatives"
                              data-dynamic
                              className="rounded-[6px] border border-line px-1.5 font-mono"
                              title={l.targetTitle}
                            >
                              {l.targetIdentifier}
                            </Link>
                          ))}
                          {model.model ? <span>Model: {model.model}</span> : null}
                          {fromCache ? <span className="text-warn">Saved copy</span> : null}
                        </div>
                      </div>
                      <OverflowMenu label="Conversation actions" items={menu} />
                    </div>
                  </header>

                  <div ref={threadRef} className="chat-tl flex-1 space-y-3 px-3 py-3 sm:px-6 sm:py-4" aria-label="Conversation timeline">
                    {detail.timeline.length === 0 && !showLive && !pendingInput ? (
                      <div className="mx-auto max-w-md py-10 text-center" data-testid="chat-empty">
                        <p className="text-[0.9375rem] font-semibold">
                          Message {areaCtx?.agent?.profile ? `@${areaCtx.agent.profile}` : session?.agentProfile ? `@${session.agentProfile}` : "Jarvis"}
                        </p>
                        <p className="mt-1 text-sm text-muted">Ask anything, or pull in context while you type:</p>
                        <ul className="mt-3 inline-flex flex-wrap justify-center gap-1.5 text-xs text-muted">
                          <li className="chip">
                            <kbd className="kbd">@</kbd> people, devices, work
                          </li>
                          <li className="chip">
                            <kbd className="kbd">#</kbd> PRs and issues
                          </li>
                          <li className="chip">
                            <kbd className="kbd">/</kbd> commands
                          </li>
                        </ul>
                      </div>
                    ) : null}
                    <ol className="space-y-2.5">
                      {groupTimeline(detail.timeline).map((g) => {
                        const row = (item: TimelineItem, stepSec?: number) => (
                          <TimelineRow
                            key={item.id}
                            item={item}
                            stepSec={stepSec}
                            onFork={() => {
                              setForkFrom(item);
                              setDialog("fork");
                            }}
                          />
                        );
                        if (!("tools" in g)) {
                          if (g.kind !== "user" && g.kind !== "assistant") return row(g);
                          return dividerIds.has(g.id) ? [<TimeDivider key={`t-${g.id}`} at={g.at!} />, row(g)] : row(g);
                        }
                        return (
                          <li key={`work-${g.tools[0].id}`}>
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
                      {showPendingUser ? (
                        <li className="flex justify-end">
                          <div className="max-w-[85%] rounded-[10px] rounded-br-[2px] bg-s3 px-3 py-1.5 sm:py-2">
                            <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">{unwrapBrokenLines(pendingInput)}</p>
                          </div>
                        </li>
                      ) : null}
                    </ol>
                    {showLive ? <LiveRun state={run.state} onApprove={answerApproval} onClarify={answerClarify} onRetry={run.retry} /> : null}
                    <div ref={bottomRef} />
                  </div>

                  {detached ? (
                    <div className="pointer-events-none sticky bottom-[132px] z-10 flex justify-center sm:bottom-[76px]">
                      <Button size="sm" className="pointer-events-auto shadow" onClick={() => jumpToLatest(true)}>
                        Jump to latest
                      </Button>
                    </div>
                  ) : null}

                  {readOnly ? (
                    <div className="safe-bottom sticky bottom-0 border-t border-line bg-bg/95 px-4 py-3 text-sm text-muted sm:px-6">
                      <ChatTray things={chatThings.things} onOpen={openPanel} />
                      This conversation was shared with you.{" "}
                      <button type="button" className="font-medium text-accent underline" onClick={() => (setForkFrom(undefined), setDialog("fork"))}>
                        Fork it
                      </button>{" "}
                      to continue it as your own.
                    </div>
                  ) : (
                    <Composer
                      tray={
                        <ChatTray
                          things={chatThings.things}
                          onOpen={openPanel}
                          compact={phase === "waiting_for_approval" || !!run.state.clarify}
                          accessory={
                            wfRun?.status === "live" ? (
                              <div className="chat-capture-chips flex gap-1 overflow-x-auto p-1" data-scroll-x role="group" aria-label="Next note goes to">
                                {workflowChips.map((c) => (
                                  <button
                                    key={c.field}
                                    type="button"
                                    className="chip min-h-11 shrink-0 sm:min-h-10 dense:min-h-8"
                                    aria-pressed={wfTarget === c.field}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => setWfTarget(wfTarget === c.field ? null : c.field)}
                                  >
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                            ) : null
                          }
                        />
                      }
                      sessionId={sessionId}
                      phase={phase}
                      clarifying={!!run.state.clarify}
                      online={online}
                      context={context}
                      onRemoveContext={removeContext}
                      onAttach={() => setDialog("context")}
                      attachments={attachments}
                      onSend={send}
                      restore={restore}
                      onSteer={steer}
                      onStop={run.stop}
                      onCommand={runCommand}
                      repo={areaCtx?.settings?.defaultRepo ?? null}
                      modelLabel={model.model ?? (areaCtx?.settings?.defaultModel ? `${areaCtx.settings.defaultModel} (area)` : "Default")}
                      onModel={() => setDialog("model")}
                      onFocus={toLatest}
                      agent={
                        areaCtx?.agent ??
                        (session?.agentProfile ? { requested: session.agentProfile, profile: session.agentProfile, routed: true, reason: "routed" } : null)
                      }
                    />
                  )}

                  <RenameDialog open={dialog === "rename"} onClose={() => setDialog(null)} session={session!} />
                  <ForkDialog open={dialog === "fork"} onClose={() => setDialog(null)} session={session!} fromMessage={forkFrom} />
                  <TrackDialog open={dialog === "track"} onClose={() => setDialog(null)} session={session!} />
                  {dialog === "model" ? (
                    <ModelSelectDialog
                      open
                      onClose={() => setDialog(null)}
                      backend={session!.source === "claude" ? "claude" : "hermes"}
                      value={model}
                      onChange={(m) => {
                        setModel(m);
                        kvSet(`model:${sessionId}`, m);
                      }}
                      area={
                        areaCtx?.area && !areaCtx.area.builtIn
                          ? { id: areaCtx.area.id, title: areaCtx.area.title, defaultModel: areaCtx.settings?.defaultModel ?? null }
                          : null
                      }
                      onAreaDefault={(m) =>
                        areaCtx?.area &&
                        api
                          .patch(`/api/work/items/${encodeURIComponent(areaCtx.area.id)}`, {
                            settings: { defaultModel: m.model ?? null, defaultProvider: m.provider ?? null },
                          })
                          .then(() => {
                            qc.invalidateQueries({ queryKey: ["work"] });
                            toast(`Default model for ${areaCtx.area!.title} saved`, "ok");
                          })
                          .catch((e: Error) => toast(e.message, "danger"))
                      }
                    />
                  ) : null}
                  {dialog === "file" ? (
                    <FileUnderDialog
                      c={{ id: sessionId, title: session!.title, suggestions: areaCtx?.suggestions ?? [] }}
                      items={treeItems.data?.items ?? []}
                      busy={false}
                      onClose={() => setDialog(null)}
                      onFile={async (itemId) => {
                        if (await fileTo(itemId)) setDialog(null);
                      }}
                    />
                  ) : null}
                  <ContextSheet
                    open={dialog === "context"}
                    onClose={() => setDialog(null)}
                    sessionId={sessionId}
                    areaTitle={areaCtx?.placement?.path?.split(" / ")[0] ?? null}
                    repo={areaCtx?.settings?.defaultRepo ?? null}
                    selected={context}
                    onToggle={(chip) =>
                      setContext((c) => (c.some((x) => x.ref === chip.ref) ? c.filter((x) => x.ref !== chip.ref) : [...c, chip].slice(0, 12)))
                    }
                  />
                </div>
                <ChatPanel
                  sessionId={sessionId}
                  open={surface.open}
                  wide={surface.wide}
                  tab={surface.tab}
                  onTab={(tab) => {
                    surface.setTab(tab);
                    chatThings.markSeen(tab);
                  }}
                  onClose={surface.close}
                  things={chatThings.things}
                  links={panel.links}
                  context={context}
                  readOnly={readOnly}
                  onPatch={panel.patch}
                  onRemoveContext={removeContext}
                  execution={chatThings.execution}
                  executionError={chatThings.error}
                  executionLoading={chatThings.loading}
                  retry={chatThings.retry}
                  onAddContext={() => {
                    surface.close();
                    setDialog("context");
                  }}
                  workflow={wfRun ? { run: wfRun, target: wfTarget, onTarget: setWfTarget, capture } : null}
                  pending={
                    run.state.approval || run.state.clarify ? (
                      <p className="rounded-lg border border-line p-2 text-xs text-warn">
                        {run.state.approval ? "Approval waiting" : "A question is waiting"} ·{" "}
                        <button
                          type="button"
                          className="min-h-11 underline sm:min-h-10"
                          onClick={() => {
                            surface.close();
                            document.querySelector('[aria-label="Current run"]')?.scrollIntoView({ block: "center" });
                          }}
                        >
                          Review in conversation
                        </button>
                      </p>
                    ) : null
                  }
                />
              </div>
            </div>
          </ChatLinkProvider>
        </ChatFiles.Provider>
      </SmartSession.Provider>
    </AssistantName.Provider>
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

function TimelineRow({ item, onFork, stepSec }: { item: TimelineItem; onFork: () => void; stepSec?: number }) {
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
      <li className="chat-msg group flex flex-col items-end" data-meta={meta || undefined}>
        <span className="mb-0.5 text-[11px] text-muted">Sent while it was working</span>
        <div className="max-w-[85%] rounded-[10px] rounded-br-[2px] bg-s3 px-3 py-1.5 sm:py-2" data-testid="msg-bubble" data-who="user" onClick={onClick}>
          <span className="sr-only">You said mid-run: </span>
          <UserText text={notice.text} />
        </div>
        <MessageMeta time={time} onFork={onFork} who="your message" text={notice.text} />
      </li>
    );
  }
  if (item.kind === "user") {
    return (
      <li className="chat-msg group flex flex-col items-end" data-meta={meta || undefined}>
        <div
          className="max-w-[85%] rounded-[10px] rounded-br-[2px] bg-s3 px-3 py-1.5 sm:py-2"
          data-testid="msg-bubble"
          data-who="user"
          onClick={onClick}
          onContextMenu={() => setMeta(true)}
        >
          <span className="sr-only">You said: </span>
          <UserText text={item.text} />
        </div>
        <MessageMeta time={time} onFork={onFork} who="your message" text={item.text} />
      </li>
    );
  }
  if (item.kind === "assistant") {
    return (
      <li className="chat-msg flex flex-col" data-meta={meta || undefined}>
        <div className="min-w-0 max-w-full" data-testid="msg-bubble" data-who="assistant" onClick={onClick} onContextMenu={() => setMeta(true)}>
          <span className="sr-only">{who} said: </span>
          <AssistantText text={item.text} />
        </div>
        <MessageMeta time={time} onFork={onFork} who={`${who}' message`} text={item.text} />
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

/**
 * A sent message: reference tokens render as chips; the context Jarvis
 * attached (snapshots of references and sources) folds into a disclosure.
 */
function UserText({ text }: { text: string }) {
  const at = text.indexOf(CONTEXT_MARK);
  const body = at >= 0 ? text.slice(0, at) : text;
  const ctx = at >= 0 ? text.slice(at + CONTEXT_MARK.length).trim() : "";
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

function MessageMeta({ time, onFork, who, text }: { time?: string; onFork: () => void; who: string; text: string }) {
  const isHermes = useContext(AssistantName) === "Hermes";
  const { toast } = useToast();
  const at = text.indexOf(CONTEXT_MARK);
  const body = at >= 0 ? text.slice(0, at).trim() : text;
  return (
    <div className="msg-meta flex items-center gap-0.5 text-xs text-muted" data-testid="msg-meta">
      {time ? (
        <span className="px-1" data-dynamic>
          {time}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(body).then(() => toast("Copied", "ok"))}
        className="inline-flex min-h-11 items-center gap-1 rounded-[6px] px-2 hover:bg-surface-2 sm:min-h-8 dense:min-h-7"
        aria-label={`Copy ${who}`}
      >
        Copy
      </button>
      <button
        type="button"
        onClick={onFork}
        className="inline-flex min-h-11 items-center gap-1 rounded-[6px] px-2 hover:bg-surface-2 sm:min-h-8 dense:min-h-7"
        aria-label={`${isHermes ? "Restart with text through" : "Fork from"} ${who}${time ? ` at ${time}` : ""}`}
      >
        <ForkIcon className="h-3.5 w-3.5" /> {isHermes ? "Restart with text" : "Fork from here"}
      </button>
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
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="chat-tool">
        <BrainIcon className="h-4 w-4 shrink-0" />
        <span className={cx("min-w-0 flex-1 break-words", status === "running" && "chat-work-shimmer")}>{label}</span>
        <span className={cx("shrink-0 text-xs", status === "failed" && "text-danger")}>{status}</span>
      </button>
      {open && a.summary ? <p className="ml-5 text-xs">{a.summary}</p> : null}
    </li>
  );
}

function LiveRun({
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
          Queued — waiting for an available agent slot. You can leave this chat; the server will start it automatically.
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

function Composer({
  tray,
  sessionId,
  phase,
  online,
  context,
  onRemoveContext,
  onAttach,
  attachments,
  onSend,
  onSteer,
  onStop,
  onCommand,
  repo: areaRepo,
  modelLabel,
  onModel,
  onFocus,
  agent,
  restore,
  clarifying,
}: {
  tray: ReactNode;
  sessionId: string;
  restore?: { text: string; key: string; at: number };
  phase?: RunPhase;
  /** #185: a clarify question is waiting — keep the composer one compact row like an approval */
  clarifying?: boolean;
  online: boolean;
  context: { label: string; ref: string }[];
  onRemoveContext: (ref: string) => void;
  onAttach: () => void;
  attachments: ChatAttachments;
  onSend: (text: string, key: string) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onStop: () => void;
  onCommand: (id: CommandId) => void;
  /** the area's default repo (the # picker's scope) */
  repo: string | null;
  modelLabel: string;
  onModel: () => void;
  /** composer focused: scroll the conversation to the latest message */
  onFocus?: () => void;
  /** who answers (Settings → Agents); shown when an agent is involved */
  agent?: AgentResolution | null;
}) {
  const who = useContext(AssistantName);
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKey = useRef<string | undefined>(undefined);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const running = phase !== undefined && !isTerminal(phase);
  const canSteer = phase === "running";
  // @ / # / picker state: the trigger at the caret, the highlighted row, picked references.
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Reference[]>([]);
  const [repo, setRepo] = useState<string | null>(areaRepo);
  const [seenRepo, setSeenRepo] = useState(areaRepo);
  if (areaRepo !== seenRepo) {
    setSeenRepo(areaRepo);
    setRepo(areaRepo);
  }
  const [seenRestore, setSeenRestore] = useState(restore);
  if (restore !== seenRestore) {
    setSeenRestore(restore);
    if (restore) setText(restore.text);
  }
  // Retry with the same key: if the first send did reach Hermes, it isn't run twice.
  useEffect(() => {
    if (restore) pendingKey.current = restore.key;
  }, [restore]);
  const listId = useId();
  const { rows, loading, partial, searched } = useTriggerRows(trigger, repo);
  const activeIdx = Math.min(active, Math.max(0, rows.length - 1));

  // Drafts persist per session across refresh/navigation.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load the session-specific IndexedDB draft
    setLoaded(false);
    Promise.all([kvGet<string>(`draft:${sessionId}`), kvGet<{ input: string; key: string }>(`pending:${sessionId}`)]).then(([d, pending]) => {
      if (pending) {
        setText(pending.input);
        pendingKey.current = pending.key; // retry with the same idempotency key
      } else setText(d ?? "");
      setLoaded(true);
    });
  }, [sessionId]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => (text ? kvSet(`draft:${sessionId}`, text) : kvDel(`draft:${sessionId}`)), 200);
    return () => clearTimeout(t);
  }, [text, sessionId, loaded]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const mod = useModKey();

  const syncTrigger = (value: string, caret: number) => {
    const t = triggerAt(value, caret);
    setTrigger(t);
    if (!t || t.sigil !== trigger?.sigil || t.query !== trigger?.query) setActive(0);
  };

  const replaceTrigger = (insert: string) => {
    if (!trigger) return;
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
    setText(next);
    setTrigger(null);
    const caret = trigger.start + insert.length;
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(caret, caret);
    });
  };

  const pick = (row: PickerRow) => {
    if (!trigger) return;
    if (row.kind === "command") {
      replaceTrigger("");
      onCommand(row.id);
      return;
    }
    if (row.kind === "ref") {
      const r: Reference = { type: row.option.type, id: row.option.id, label: row.option.label };
      setPicked((p) => (p.some((x) => x.type === r.type && x.id === r.id) ? p : [...p, r]));
      replaceTrigger(`${displayRef(r)} `);
    }
  };

  const filterTo = (type: string) => {
    if (!trigger) return;
    const q = trigger.query.replace(/^[a-z]+:/i, "");
    const insert = `@${type}:${q}`;
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
    setText(next);
    const caret = trigger.start + insert.length;
    setTrigger({ sigil: "@", query: `${type}:${q}`, start: trigger.start, end: caret });
    setActive(0);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(caret, caret);
    });
  };

  const submit = async () => {
    const typed = text.trim();
    const hasFiles = attachments.drafts.length > 0;
    if ((!typed && !hasFiles) || busy || !online) return;
    if (attachments.uploading) {
      toast("Wait for the attachments to finish uploading", "danger");
      return;
    }
    if (hasFiles && running) {
      toast("Attachments go with a new message — wait for this reply to finish", "danger");
      return;
    }
    const input = typed || (attachments.drafts.some((d) => d.kind === "image") ? "What do you see in this?" : "Here's the attached file.");
    // A bare command typed in full ("/fork") runs instead of sending.
    const cmd = input.match(/^\/([a-z]+)$/i)?.[1]?.toLowerCase();
    if (cmd && rows.some((r) => r.row.kind === "command" && r.row.id === cmd)) {
      setText("");
      setTrigger(null);
      onCommand(cmd as CommandId);
      return;
    }
    setBusy(true);
    let ok: boolean;
    const encoded = encodeMessage(input, picked).text;
    if (running) {
      ok = canSteer ? await onSteer(encoded) : false;
    } else {
      const key = pendingKey.current ?? newIdempotencyKey("run");
      pendingKey.current = key;
      ok = await onSend(encoded, key);
      if (ok) pendingKey.current = undefined;
    }
    if (ok) {
      setText("");
      setPicked([]);
      setTrigger(null);
      await kvDel(`draft:${sessionId}`);
    }
    setBusy(false);
  };

  const awaitingApproval = phase === "waiting_for_approval";
  // #185: an approval or clarify card needs the screen; at 320 px / 200 % text a stacked composer covers its buttons.
  const compact = awaitingApproval || !!clarifying;
  const placeholder = !online
    ? "Offline — drafts are saved, not sent"
    : phase === "waiting_for_approval"
      ? "Answer the approval first"
      : running
        ? "Add guidance…"
        : `Message ${who}…`;
  const open = !!trigger && (rows.length > 0 || loading || trigger.sigil !== "@" || trigger.query.length > 0);

  return (
    <div className="chat-dock safe-bottom sticky z-20 border-t border-line bg-bg/95 px-2 py-1.5 backdrop-blur sm:px-6 sm:py-2">
      <div className="chat-composer-card mx-auto max-w-[760px] rounded-xl border border-line bg-surface">
        {tray}
        <div className="chat-composer-context flex flex-wrap items-center gap-1 px-2" data-compact={compact || undefined}>
          {agent && (agent.routed || agent.requested) ? <AgentChip agent={agent} /> : null}
          {context.map((c) => (
            <button key={c.ref} type="button" onClick={() => onRemoveContext(c.ref)} className="chip cursor-pointer" aria-label={`Remove context ${c.label}`}>
              {c.label} ✕
            </button>
          ))}
        </div>
        <div className="mx-auto max-w-[760px]">
          <AttachmentChips drafts={attachments.drafts} onRemove={attachments.remove} onRetry={attachments.retry} />
        </div>
        <form
          className="chat-comp relative flex flex-wrap items-end gap-1"
          onMouseDown={(e) => {
            // While typing, tapping a composer button (send, +, menu items) keeps the focus in the text field: the
            // keyboard stays up and the layout doesn't jump under the finger (which can swallow the tap).
            if (document.activeElement === ta.current && (e.target as HTMLElement).closest("button")) e.preventDefault();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {open ? (
            <TriggerPopover
              trigger={trigger!}
              rows={rows}
              active={activeIdx}
              loading={loading}
              partial={partial}
              repo={repo}
              searched={searched}
              onRepo={setRepo}
              onPick={pick}
              onHover={setActive}
              onFilter={filterTo}
              listId={listId}
            />
          ) : null}
          {/* Phones: one "+" sheet (context, files, camera, photos, model) so the text field gets the width. */}
          <ComposerAddMenu
            online={online}
            files={!compact}
            modelLabel={modelLabel}
            onContext={onAttach}
            onModel={onModel}
            onFile={() => fileInput.current?.click()}
            onCamera={() => cameraInput.current?.click()}
            onLibrary={attachments.add}
          />
          <Button type="button" variant="ghost" onClick={onAttach} aria-label="Attach context" className="shrink-0 px-3 max-sm:hidden">
            +
          </Button>
          {/* While an approval waits nothing can be sent: keep the composer one compact row (pre-attachments layout),
            so on small phones at large text sizes it doesn't cover the approval card's buttons. */}
          {!compact ? <AttachButton onFiles={attachments.add} disabled={!online} buttonClassName="max-sm:hidden" inputRef={fileInput} /> : null}
          {!compact ? <CameraButton onFiles={attachments.add} disabled={!online} buttonClassName="max-sm:hidden" inputRef={cameraInput} /> : null}
          <label htmlFor="composer" className="sr-only">
            {running ? "Guidance for the current run" : `Message ${who}`}
          </label>
          <textarea
            id="composer"
            ref={ta}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && rows.length ? `${listId}-${activeIdx}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              syncTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              if (trigger) syncTrigger(el.value, el.selectionStart ?? el.value.length);
            }}
            onBlur={() => setTimeout(() => setTrigger(null), 150)}
            onFocus={onFocus}
            onPaste={(e) => {
              const files = pastedFiles(e);
              if (!files.length) return;
              e.preventDefault();
              attachments.add(files);
            }}
            onKeyDown={(e) => {
              if (open && rows.length) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => (a + 1) % rows.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => (a - 1 + rows.length) % rows.length);
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  pick(rows[activeIdx]!.row);
                  return;
                }
              }
              if (open && e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                return;
              }
              // Enter is a newline (phone and desktop); Ctrl/⌘ + Enter or the Send button sends.
              if (isSendShortcut(composerKey(e))) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && running) {
                e.preventDefault();
                onStop();
              }
            }}
            className={`block max-h-[200px] min-h-11 w-full min-w-0 flex-1 resize-none ${running && !compact ? "max-[400px]:order-first max-[400px]:basis-full" : ""} rounded-[6px] border-0 bg-transparent px-2 py-2.5 text-base focus:outline-none sm:min-h-10 sm:py-2 sm:text-[0.875rem] dense:min-h-8 dense:py-1.5`}
          />
          <button
            type="button"
            className="chip mb-1.5 shrink-0 cursor-pointer self-end hover:border-line-strong max-sm:hidden"
            onClick={onModel}
            aria-label={`Model: ${modelLabel}. Change`}
            data-testid="model-chip"
          >
            <span className="text-muted">Model</span> {modelLabel} <span aria-hidden="true">▾</span>
          </button>
          {running ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onStop}
              aria-label="Stop the run (Escape)"
              disabled={phase === "stopping"}
              className="shrink-0 max-[400px]:ml-auto"
            >
              <StopIcon className="h-5 w-5" />
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={
              (!text.trim() && !attachments.readyIds.length) || !online || phase === "waiting_for_approval" || phase === "stopping" || (running && !canSteer)
            }
            aria-label={running ? "Send guidance" : "Send"}
            title={`${running ? "Send guidance" : "Send"} (${sendHint(mod)})`}
            aria-keyshortcuts={SEND_KEYSHORTCUTS}
            className={running ? "shrink-0" : "shrink-0 max-[400px]:ml-auto"}
          >
            {!busy ? <SendIcon className="h-5 w-5" /> : null}
          </Button>
        </form>
      </div>
      {!online && text ? <p className="mt-1 text-xs text-warn">Draft saved on this device. It has not been sent.</p> : null}
    </div>
  );
}

/**
 * Phone-only "+" menu of the composer: context, files, camera, photo library and the model.
 * Files and camera reuse the composer's own hidden inputs; the photo library has its own picker.
 */
function ComposerAddMenu({
  online,
  files,
  modelLabel,
  onContext,
  onModel,
  onFile,
  onCamera,
  onLibrary,
}: {
  online: boolean;
  files: boolean;
  modelLabel: string;
  onContext: () => void;
  onModel: () => void;
  onFile: () => void;
  onCamera: () => void;
  onLibrary: (f: File[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const id = useId();
  // Opened from the keyboard: focus the first item (WAI-ARIA menu). Opened by a tap: leave focus where it was,
  // so the on-screen keyboard stays up and nothing shifts under the finger.
  const [byKeyboard, setByKeyboard] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (byKeyboard) list.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const onDoc = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      if (list.current?.contains(document.activeElement)) btn.current?.focus();
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onEsc, true);
    };
  }, [open, byKeyboard]);
  const items: { label: string; hint?: string; onSelect: () => void; disabled?: boolean; library?: boolean }[] = [
    { label: "Context", hint: "areas, items, people", onSelect: onContext },
    ...(files
      ? [
          { label: "Attach file", onSelect: onFile, disabled: !online },
          { label: "Camera", onSelect: onCamera, disabled: !online },
          { label: "Photo library", onSelect: () => undefined, disabled: !online, library: true },
        ]
      : []),
    { label: "Model", hint: modelLabel, onSelect: onModel },
  ];
  const onKey = (e: React.KeyboardEvent) => {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(idx + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };
  return (
    <div className="relative shrink-0 sm:hidden">
      <button
        ref={btn}
        type="button"
        aria-label="Add to message"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          setByKeyboard(e.detail === 0);
          setOpen((o) => !o);
        }}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-text"
        data-testid="composer-add"
      >
        <PlusIcon className="h-5 w-5" />
      </button>
      {open ? (
        <ul
          ref={list}
          id={id}
          role="menu"
          aria-label="Add to message"
          onKeyDown={onKey}
          className="absolute bottom-full left-0 z-40 mb-2 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[12px] border border-line bg-surface p-1 shadow-[var(--shadow-pop)]"
        >
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                role="menuitem"
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  if (it.library) library.current?.click();
                  else it.onSelect();
                }}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[6px] px-3 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              >
                <span>{it.label}</span>
                {it.hint ? <span className="min-w-0 truncate text-xs text-muted">{it.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={library}
        type="file"
        multiple
        accept="image/*"
        aria-label="Choose pictures from the photo library"
        data-testid="chat-library-input"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          onLibrary([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** C1 share text: title, agent, area path, the latest reply (trimmed) and the in-app link (sign-in required). */
export function shareSummary(x: { title: string; agent: string | null; assistant: string; path: string | null; timeline: TimelineItem[]; url: string }) {
  const last = [...x.timeline].reverse().find((t) => t.kind === "assistant");
  const reply = last && "text" in last ? last.text.replace(/\s+/g, " ").trim() : "";
  const excerpt = reply.length > 280 ? `${reply.slice(0, 279)}…` : reply;
  const messages = x.timeline.filter((t) => t.kind === "user" || t.kind === "assistant").length;
  return [
    x.title,
    `${x.agent ? `@${x.agent}` : x.assistant}${x.path ? ` · ${x.path}` : ""} · ${messages} ${messages === 1 ? "message" : "messages"}`,
    excerpt ? `Latest: ${excerpt}` : null,
    `${x.url} (opens in Jarvis; sign-in required, read-only for anyone it is shared with)`,
  ]
    .filter(Boolean)
    .join("\n");
}
