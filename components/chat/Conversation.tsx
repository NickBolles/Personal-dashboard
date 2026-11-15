"use client";
import { refreshSessionLists } from "@/lib/client/session-lists";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { kvDel, kvGet, kvSet, rememberSession } from "@/lib/client/idb";
import { takeFirstRun } from "@/lib/client/first-run";
import type { EntityLink } from "@/lib/contracts";
import { maskedNotice, type ApprovalRequest, type RunPhase, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { ErrorNote, IconButton, useOnline, useToast } from "@/components/ui";
import { Badge, Button, OverflowMenu, Spinner, type Tone } from "@/components/ui/legacy";
import { ChevronIcon, ForkIcon, PanelIcon } from "@/components/icons";
import { useKeyboardInset } from "@/lib/client/keyboard";
import { quickAdd, useAgentCapture, useWorkflowRun } from "@/components/workflows/RunPanel";
import { useAccess } from "@/components/access";
import { useRunStream, type RunState } from "./useRunStream";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { SmartScope } from "@/components/smart/SmartScope";
import { ForkDialog, RenameDialog, TrackDialog } from "./dialogs";
import { ContextSheet, type ContextChip } from "./ContextSheet";
import { usePanelLinks } from "./LinksPanel";
import { useFollowScroll } from "./useFollowScroll";
import { ChatPanel, ParentChatLink } from "./things/ChatPanel";
import { ChatTray } from "./things/ChatTray";
import { ChatLinkProvider } from "./things/ChatLinkProvider";
import { useChatThings } from "./things/useChatThings";
import { useChatPanelLayout } from "./things/useChatPanelLayout";
import type { ChatThings, ThingsTab } from "@/lib/chat/things";
import "./things/things.css";
import { DropOverlay, useChatAttachments, useConversationFiles, useFileDrop } from "./Attachments";
import { Composer } from "./Composer";
import { AssistantName, ChatFiles, NO_FILES, RateCtx, Timeline, type RateContext } from "./Timeline";

// The timeline moved to ./Timeline; this name is still imported from here.
export { groupTimeline } from "./Timeline";
import { useAskHermes } from "./useAskHermes";
import { ModelSelectDialog } from "@/components/areas/ModelPicker";
import { FileUnderDialog } from "@/components/work/conversations";
import { type CommandId } from "@/lib/references";
import type { AreaSettings, FilingSuggestion, ConversationPlacement, ItemsResponse } from "@/lib/work";
import type { AgentResolution } from "@/lib/agents";
import { actionsByReply } from "@/lib/chat/actions";
import { answererName } from "@/lib/chat/display";
import { OPEN_CHAT_RUNNING } from "./ActionsTaken";

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

/** Tool names used for each assistant reply (the tool steps since the previous user message). */
export function toolsByReply(timeline: TimelineItem[]) {
  const out = new Map<string, string[]>();
  let tools: string[] = [];
  for (const t of timeline) {
    if (t.kind === "user") tools = [];
    else if (t.kind === "tool") tools.push(t.tool);
    else if (t.kind === "assistant") {
      out.set(t.id, tools);
      tools = [];
    }
  }
  return out;
}

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
  const replyActions = useMemo(
    () => new Map(actionsByReply(detail?.timeline ?? NO_TIMELINE).map((group) => [group.replyId, group.actions])),
    [detail?.timeline],
  );
  /** This chat handed work off or started a run: only then is a failed background-work check worth a line in the tray. */
  const startedBackground = useMemo(
    () => [...replyActions.values()].some((actions) => actions.some((a) => a.kind === "delegated" || a.kind === "run_started")),
    [replyActions],
  );
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
      // The tray must not keep saying "Running" under a header that says "Done": re-check background work now.
      qc.invalidateQueries({ queryKey: ["chat-execution", sessionId] });
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
        const notice = maskedNotice(r);
        if (notice) toast(notice, "warn");
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
    pending: {
      approval: !!run.state.approval,
      clarify: !!run.state.clarify && run.active,
      // The tray names what is being asked (the request’s own words), and the run’s own record is not listed beside it.
      detail: run.state.approval
        ? run.state.approval.description || run.state.approval.command
        : run.state.clarify && run.active
          ? run.state.clarify.question
          : undefined,
      runId: run.state.runId,
    },
    parentRunning: run.active,
    parentFailed: run.state.phase === "failed" || run.state.phase === "interrupted",
    expectsBackground: startedBackground || Boolean(detail?.session.subagentCount),
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
  const runningLinkHandled = useRef<string | null>(null);
  useEffect(() => {
    const showRunning = () => {
      surface.show("Running");
      chatThings.markSeen("Running");
    };
    const onRunning = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) showRunning();
    };
    window.addEventListener(OPEN_CHAT_RUNNING, onRunning);
    if (detail && runningLinkHandled.current !== sessionId) {
      runningLinkHandled.current = sessionId;
      if (new URLSearchParams(window.location.search).get("panel") === "running") showRunning();
    }
    return () => window.removeEventListener(OPEN_CHAT_RUNNING, onRunning);
  }, [sessionId, detail, surface, chatThings]);
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
      jumpToLatest(false, true);
      const notice = maskedNotice(r);
      if (notice) toast(notice, "warn");
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
      jumpToLatest(false, true);
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
  const { below, jumpToLatest } = useFollowScroll(threadRef, bottomRef, Boolean(detail));
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
  /** Who answers here: "@profile", "Claude" or the assistant. The empty state and the composer name the same one. */
  const answerer = answererName({ agentProfile: areaCtx?.agent?.profile ?? session!.agentProfile, assistant: who });
  const trayLine: ChatThings["line"] | undefined = chatThings.things.line;
  const jump = below ? (
    <div className="chat-jump">
      <Button size="sm" onClick={() => jumpToLatest(true)}>
        Jump to latest
      </Button>
    </div>
  ) : null;
  // Time dividers: shown before the first message and after gaps over 5 minutes (per-message times are on tap).
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

  const toolMap = toolsByReply(detail?.timeline ?? NO_TIMELINE);
  // Feedback is its own plain turn, never a submission of the staged composer.
  const sendCorrection = async (prompt: string) => {
    if (run.active) {
      toast("Wait for the current reply to finish, then ask again.", "warn");
      return false;
    }
    try {
      const r = await api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/runs`, {
        input: prompt,
        idempotencyKey: newIdempotencyKey("fix"),
        capabilities: [SMART_CAPABILITY],
        ...model,
      });
      setPendingInput(prompt);
      announce(`Message sent. ${who} is responding.`);
      jumpToLatest(false, true);
      run.start(r.runId);
      refreshSessionLists(qc);
      return true;
    } catch (err) {
      toast(`Correction not sent: ${(err as Error).message}`, "danger");
      return false;
    }
  };
  const rateCtx: RateContext | null =
    detail && !detail.session.readOnly
      ? {
          sessionId,
          model: detail.session.model ?? null,
          toolsFor: (id) => toolMap.get(id) ?? [],
          askFix: sendCorrection,
        }
      : null;

  return (
    <AssistantName.Provider value={who}>
      <RateCtx.Provider value={rateCtx}>
        {/* A questionnaire smart form's Submit sends its answers as the owner's reply (PR A, F2). */}
        <SmartScope session={sessionId} reply={(text: string) => send(text, newIdempotencyKey("form"))}>
          <ChatFiles.Provider value={{ sessionId, files: filesQ.data ?? NO_FILES }}>
            <ChatLinkProvider links={panel.links}>
              <div ref={chatWrapperRef} className="chat-things-container @container" data-panel-open={(surface.wide && surface.open) || undefined}>
                <div className="chat-things-layout">
                  <div className="chat-page relative mx-auto flex w-full max-w-[880px] min-w-0 flex-1 flex-col" data-testid="conversation-drop" {...drop.props}>
                    <DropOverlay show={drop.over} />
                    <header className="chat-head sticky top-0 z-20 border-b border-line bg-bg/95 px-3 py-1.5 backdrop-blur sm:px-6 sm:py-2.5">
                      <div className="flex items-center gap-1.5 sm:items-start sm:gap-2">
                        <Link
                          href="/chat"
                          className="chat-head-btn -ml-2 inline-flex items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden"
                          aria-label="Back to conversations"
                        >
                          <ChevronIcon className="h-5 w-5 rotate-180" />
                        </Link>
                        <div className="min-w-0 flex-1">
                          <h1 className="truncate text-[0.9375rem] leading-5 font-semibold tracking-[-0.01em] sm:text-[1.0625rem] sm:leading-6">
                            {session!.title}
                          </h1>
                          <ParentChatLink parent={chatThings.execution?.parent} />
                          {/* One quiet line of context: status, where the chat is filed, one filing suggestion. Phones keep
                              it to one line that scrolls sideways (a wrapped header at large text leaves no room between
                              it and the composer); wider screens wrap when it has more to say (forks, links). */}
                          <div
                            data-scroll-x
                            className="chat-head-chips scroll-x-clean mt-0.5 flex min-w-0 items-center gap-x-2 gap-y-0.5 text-xs whitespace-nowrap text-muted sm:flex-wrap sm:whitespace-normal"
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
                              <span className="contents" data-testid="area-chip">
                                {/* C1: the area path reads as a breadcrumb (tap to file elsewhere), not another chip. */}
                                <button
                                  type="button"
                                  className="chat-head-area"
                                  title={areaCtx.placement?.path ?? "Not in Areas yet"}
                                  onClick={() => setDialog("file")}
                                  aria-label={`In ${areaCtx.placement?.path || "no area"}. File elsewhere`}
                                >
                                  <span className="truncate">{areaCtx.placement?.path || "Not in Areas"}</span>
                                  <ChevronIcon className="h-3 w-3 shrink-0 rotate-90" />
                                </button>
                                {/* Filing suggestions are quiet text links: two at most, one while a run is live. Phones show
                                    one, and none while a run needs the line for its status. The ▾ dialog and the ⋯ menu
                                    always offer every destination. */}
                                {areaCtx.suggestions.slice(0, liveActive ? 1 : 2).map((sg, i) => (
                                  <button
                                    key={sg.id}
                                    type="button"
                                    className="chat-head-suggest"
                                    data-hide={i > 0 || liveActive ? "phone" : undefined}
                                    title={`${sg.path} — shares: ${sg.matched.join(", ")}`}
                                    onClick={() => fileTo(sg.id, sg.title)}
                                  >
                                    <span className="truncate">File under {sg.title}</span>
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
                        {/* The chat panel (links, files, background work) opens from here, so an idle chat needs no tray. */}
                        {surface.wide && surface.open ? null : (
                          <span className="relative inline-flex shrink-0">
                            <IconButton
                              label="Open chat panel"
                              icon={<PanelIcon className="h-5 w-5" />}
                              className="chat-head-btn border-transparent bg-transparent"
                              onClick={() => openPanel(trayLine && trayLine.state !== "quiet" ? trayLine.tab : surface.tab)}
                            />
                            {trayLine?.dot ? (
                              <span aria-hidden="true" className="chat-attention-dot absolute top-1.5 right-1.5" data-dot={trayLine.dot} />
                            ) : null}
                          </span>
                        )}
                        <OverflowMenu
                          label="Conversation actions"
                          items={menu}
                          triggerClassName="chat-head-btn inline-flex items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
                        />
                      </div>
                    </header>

                    <div ref={threadRef} className="chat-tl flex-1 space-y-3 px-3 py-3 sm:px-6 sm:py-4" aria-label="Conversation timeline">
                      {detail.timeline.length === 0 && !showLive && !pendingInput ? (
                        <div className="mx-auto max-w-md py-10 text-center" data-testid="chat-empty">
                          <p className="text-[0.9375rem] font-semibold">Message {answerer}</p>
                          <p className="mt-1 text-sm text-muted">Ask anything, or pull in context while you type:</p>
                          {/* Hints, not controls: plain text with the key to type, so nothing here looks tappable. */}
                          <ul className="mt-3 inline-flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-muted">
                            <li className="inline-flex items-center gap-1.5">
                              <kbd className="kbd">@</kbd> people, devices, work
                            </li>
                            <li className="inline-flex items-center gap-1.5">
                              <kbd className="kbd">#</kbd> PRs and issues
                            </li>
                            <li className="inline-flex items-center gap-1.5">
                              <kbd className="kbd">/</kbd> commands
                            </li>
                          </ul>
                        </div>
                      ) : null}
                      <Timeline
                        sessionId={sessionId}
                        items={detail.timeline}
                        replyActions={replyActions}
                        pending={showPendingUser ? pendingInput : undefined}
                        live={showLive ? { state: run.state, onApprove: answerApproval, onClarify: answerClarify, onRetry: run.retry } : null}
                        onFork={(item) => {
                          setForkFrom(item);
                          setDialog("fork");
                        }}
                      />
                      <div ref={bottomRef} />
                    </div>

                    {readOnly ? (
                      <div className="chat-dock safe-bottom sticky z-20 border-t border-line bg-bg px-4 py-3 text-sm text-muted sm:bg-bg/95 sm:px-6">
                        {jump}
                        <ChatTray things={chatThings.things} onOpen={openPanel} onRetry={chatThings.retry} />
                        This conversation was shared with you.{" "}
                        <button type="button" className="font-medium text-accent underline" onClick={() => (setForkFrom(undefined), setDialog("fork"))}>
                          Fork it
                        </button>{" "}
                        to continue it as your own.
                      </div>
                    ) : (
                      <Composer
                        surface="page"
                        inputId="composer"
                        jump={jump}
                        answerer={answerer}
                        tray={
                          <ChatTray
                            things={chatThings.things}
                            onOpen={openPanel}
                            onRetry={chatThings.retry}
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
        </SmartScope>
      </RateCtx.Provider>
    </AssistantName.Provider>
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
