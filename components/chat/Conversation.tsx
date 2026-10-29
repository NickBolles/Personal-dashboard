"use client";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { Markdown } from "@/components/markdown/Markdown";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { kvDel, kvGet, kvSet, rememberSession } from "@/lib/client/idb";
import { takeFirstRun } from "@/lib/client/first-run";
import type { EntityLink } from "@/lib/contracts";
import { isTerminal, toolLabel, type ApprovalRequest, type RunPhase, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { formatTime } from "@/components/actions/format";
import { Badge, Button, ErrorNote, OverflowMenu, Spinner, cx, useOnline, useToast, type Tone } from "@/components/ui";
import { ChevronIcon, ForkIcon, SendIcon, StopIcon, ToolIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { useRunStream, type Activity, type RunState } from "./useRunStream";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { AssistantText, SmartSession } from "@/components/smart/AssistantText";
import { ContextPicker, ForkDialog, RenameDialog, TrackDialog } from "./dialogs";
import { TriggerPopover, useTriggerRows, type PickerRow } from "./ComposerPicker";
import { useAskHermes } from "./useAskHermes";
import { ModelSelectDialog } from "@/components/areas/ModelPicker";
import { FileUnderDialog } from "@/components/work/conversations";
import { displayRef, encodeMessage, splitReferences, triggerAt, type CommandId, type Reference, type Trigger } from "@/lib/references";
import type { AreaSettings, FilingSuggestion, ConversationPlacement, ItemsResponse } from "@/lib/work";
import type { AgentResolution } from "@/lib/agents";
import { AgentChip } from "@/components/agents/AgentChip";

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

export function Conversation({ sessionId, initialRunId }: { sessionId: string; initialRunId?: string }) {
  const qc = useQueryClient();
  const online = useOnline();
  const { toast, announce } = useToast();
  const { can } = useAccess();
  const { detail, error, refetch, fromCache, isLoading } = useSessionDetail(sessionId);
  const [pendingInput, setPendingInput] = useState<string>();
  const [dialog, setDialog] = useState<null | "rename" | "fork" | "track" | "model" | "context" | "file">(null);
  const router = useRouter();
  const newChat = useAskHermes();
  const [forkFrom, setForkFrom] = useState<TimelineItem>();
  const [model, setModel] = useState<{ model?: string; provider?: string }>({});
  const [context, setContext] = useState<{ label: string; ref: string }[]>([]);
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
      run.start(active, detail?.session.activeRun?.status === "waiting_for_approval" ? "waiting_for_approval" : "running");
    }
  }, [detail?.session.activeRun?.runId, detail?.session.activeRun?.status, initialRunId, run]);

  useEffect(() => {
    kvGet<{ model?: string; provider?: string }>(`model:${sessionId}`).then((m) => m && setModel(m));
  }, [sessionId]);

  // "Ask" opened this conversation before its first message was sent: show it now, stream when the run starts.
  const firstRun = useRef<string | null>(null);
  useEffect(() => {
    if (firstRun.current === sessionId) return;
    firstRun.current = sessionId;
    const first = takeFirstRun(sessionId);
    if (!first) return;
    setPendingInput(first.input);
    first.run.then(
      (r) => {
        // The resume effect may already have picked this run up from a detail refetch.
        if (resumed.current !== r.runId) {
          resumed.current = r.runId;
          run.start(r.runId);
        }
        refreshSessionLists(qc);
      },
      (err) => {
        setPendingInput(undefined);
        void kvSet(`draft:${sessionId}`, first.input);
        toast(`Not sent: ${(err as Error).message} Your message is saved as a draft.`, "danger");
      },
    );
  }, [sessionId, run, qc, toast]);

  useEffect(() => {
    if (run.state.phase === "waiting_for_approval") announce("Hermes needs your approval");
  }, [run.state.phase, announce]);

  const session = detail?.session;

  const send = async (text: string, key: string) => {
    const ctx = context.map((c) => `- ${c.label} [${c.ref}]`).join("\n");
    setPendingInput(text);
    await kvSet(`pending:${sessionId}`, { input: text, key });
    try {
      const r = await api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/runs`, {
        input: text,
        idempotencyKey: key,
        context: ctx || undefined,
        capabilities: [SMART_CAPABILITY],
        ...model,
      });
      await kvDel(`pending:${sessionId}`);
      setContext([]);
      announce(`Message sent. ${who} is responding.`);
      run.start(r.runId);
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
      toast((err as Error).message, "danger");
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

  // --- scrolling: follow output unless the user scrolled up ---
  const bottomRef = useRef<HTMLDivElement>(null);
  const [detached, setDetached] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      setDetached(gap > 160);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const contentSize = (detail?.timeline.length ?? 0) + run.state.text.length + run.state.activity.length;
  useLayoutEffect(() => {
    if (!detached) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [contentSize, detached]);
  const firstLoad = useRef(true);
  useEffect(() => {
    if (detail && firstLoad.current) {
      firstLoad.current = false;
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    }
  }, [detail]);

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
  const fork = { label: "Fork latest state", onSelect: () => (setForkFrom(undefined), setDialog("fork")), disabled: !online };
  const menu = readOnly
    ? [fork]
    : [
        { label: "Rename", onSelect: () => setDialog("rename") },
        fork,
        { label: "Model…", onSelect: () => setDialog("model") },
        ...(canAreas ? [{ label: "File under…", onSelect: () => setDialog("file") }] : []),
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
  menu.push({
    label: "Copy link",
    onSelect: () => {
      navigator.clipboard?.writeText(window.location.origin + `/chat/${encodeURIComponent(sessionId)}`).then(() => toast("Link copied", "ok"));
    },
  });

  return (
    <AssistantName.Provider value={who}>
      <SmartSession.Provider value={sessionId}>
        <div className="mx-auto flex min-h-[calc(100dvh-76px)] max-w-[880px] flex-col sm:min-h-[calc(100dvh-44px)]">
          <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 py-2.5 backdrop-blur sm:px-6">
            <div className="flex items-start gap-2">
              <Link
                href="/chat"
                className="tap -ml-2 inline-flex items-center justify-center rounded-xl text-muted lg:hidden"
                aria-label="Back to conversations"
              >
                <ChevronIcon className="h-5 w-5 rotate-180" />
              </Link>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[1.0625rem] leading-6 font-semibold tracking-[-0.01em]">{session!.title}</h1>
                {/* One line of context chips: phones scroll it sideways instead of stacking three rows. */}
                <div className="scroll-x-clean mt-0.5 flex items-center gap-1.5 text-xs whitespace-nowrap text-muted sm:flex-wrap">
                  {phase ? <Badge tone={PHASE_LABEL[phase].tone}>{PHASE_LABEL[phase].label}</Badge> : null}
                  {session!.source === "claude" ? <Badge tone="accent">Claude · {session!.model}</Badge> : null}
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
                      <button
                        type="button"
                        className="chip cursor-pointer hover:border-line-strong"
                        title={areaCtx.placement?.path ?? "Not in Areas yet"}
                        onClick={() => setDialog("file")}
                        aria-label={`In ${areaCtx.placement?.path || "no area"}. File elsewhere`}
                      >
                        <span aria-hidden="true">▸</span> {areaCtx.placement?.path || "Not in Areas"}
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
                      {areaCtx.node ? (
                        <Link className="chip hover:border-line-strong" href={`/areas?item=${encodeURIComponent(areaCtx.node.id)}`}>
                          Properties
                        </Link>
                      ) : null}
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
                    <Link key={l.targetId} href="/initiatives" data-dynamic className="rounded-[6px] border border-line px-1.5 font-mono" title={l.targetTitle}>
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

          <div className="flex-1 space-y-3 px-4 py-4 sm:px-6" aria-label="Conversation timeline">
            {detail.timeline.length === 0 && !showLive && !pendingInput ? (
              <div className="mx-auto max-w-md py-10 text-center" data-testid="chat-empty">
                <p className="text-[0.9375rem] font-semibold">Start the conversation</p>
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
            <ol className="space-y-3">
              {detail.timeline.map((item) => (
                <TimelineRow
                  key={item.id}
                  item={item}
                  onFork={() => {
                    setForkFrom(item);
                    setDialog("fork");
                  }}
                />
              ))}
              {showPendingUser ? (
                <li className="flex justify-end">
                  <div className="max-w-[85%] rounded-[12px] rounded-br-[4px] bg-accent-soft px-3.5 py-2">
                    <p className="prose-chat">{pendingInput}</p>
                  </div>
                </li>
              ) : null}
            </ol>
            {showLive ? <LiveRun state={run.state} onApprove={answerApproval} onRetry={run.retry} /> : null}
            <div ref={bottomRef} />
          </div>

          {detached ? (
            <div className="pointer-events-none sticky bottom-[140px] z-10 flex justify-center">
              <Button size="sm" className="pointer-events-auto shadow" onClick={() => bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })}>
                Jump to latest
              </Button>
            </div>
          ) : null}

          {readOnly ? (
            <div className="safe-bottom sticky bottom-0 border-t border-line bg-bg/95 px-4 py-3 text-sm text-muted sm:px-6">
              This conversation was shared with you.{" "}
              <button type="button" className="font-medium text-accent underline" onClick={() => (setForkFrom(undefined), setDialog("fork"))}>
                Fork it
              </button>{" "}
              to continue it as your own.
            </div>
          ) : (
            <Composer
              sessionId={sessionId}
              phase={phase}
              online={online}
              context={context}
              onRemoveContext={(ref) => setContext((c) => c.filter((x) => x.ref !== ref))}
              onAttach={() => setDialog("context")}
              onSend={send}
              onSteer={steer}
              onStop={run.stop}
              onCommand={runCommand}
              repo={areaCtx?.settings?.defaultRepo ?? null}
              modelLabel={model.model ?? (areaCtx?.settings?.defaultModel ? `${areaCtx.settings.defaultModel} (area)` : "Default")}
              onModel={() => setDialog("model")}
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
          <ContextPicker
            open={dialog === "context"}
            onClose={() => setDialog(null)}
            onPick={(label, ref) => setContext((c) => (c.some((x) => x.ref === ref) ? c : [...c, { label, ref }]))}
          />
        </div>
      </SmartSession.Provider>
    </AssistantName.Provider>
  );
}

function TimelineRow({ item, onFork }: { item: TimelineItem; onFork: () => void }) {
  const who = useContext(AssistantName);
  const [open, setOpen] = useState(false);
  const time = item.at ? formatTime(item.at) : undefined;
  if (item.kind === "user") {
    return (
      <li className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-[12px] rounded-br-[4px] bg-accent-soft px-3.5 py-2">
          <span className="sr-only">You said: </span>
          <UserText text={item.text} />
        </div>
        <MessageMeta time={time} onFork={onFork} who="your message" />
      </li>
    );
  }
  if (item.kind === "assistant") {
    return (
      <li className="flex flex-col gap-1">
        <div className="max-w-[95%] rounded-[12px] rounded-bl-[4px] border border-line bg-surface px-3.5 py-2.5">
          <span className="sr-only">{who} said: </span>
          <AssistantText text={item.text} />
        </div>
        <MessageMeta time={time} onFork={onFork} who={`${who}' message`} />
      </li>
    );
  }
  if (item.kind === "tool") {
    return (
      <li>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cx(
            "flex min-h-11 w-full items-center gap-2 rounded-[10px] border border-dashed border-line px-3 text-left font-mono text-xs text-muted hover:bg-surface-2 dense:min-h-8",
            item.error && "text-danger",
          )}
        >
          <ToolIcon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {toolLabel(item.tool)}
            {item.summary ? ` · ${item.summary}` : ""}
            {item.error ? " · failed" : ""}
          </span>
          <ChevronIcon className={cx("h-4 w-4 transition-transform", open && "rotate-90")} />
        </button>
        {open ? (
          <div className="ml-9 mt-1 rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <p className="text-muted">
              Tool: <code>{item.tool}</code>
              {time ? ` · ${time}` : ""}
            </p>
            {item.detail ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{item.detail}</pre> : null}
          </div>
        ) : null}
      </li>
    );
  }
  return (
    <li className="text-center text-xs text-muted">
      <p className="prose-chat">{item.text}</p>
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
  return (
    <>
      <p className="prose-chat select-text">
        {splitReferences(body).map((p, i) =>
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
    </>
  );
}

function MessageMeta({ time, onFork, who }: { time?: string; onFork: () => void; who: string }) {
  const isHermes = useContext(AssistantName) === "Hermes";
  return (
    <div className="flex items-center gap-1 text-xs text-muted">
      {time ? <span>{time}</span> : null}
      <button
        type="button"
        onClick={onFork}
        className="inline-flex min-h-11 items-center gap-1 rounded-[6px] px-2 hover:bg-surface-2 dense:min-h-7"
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
  const label =
    a.kind === "tool"
      ? `${toolLabel(a.tool)}${a.preview ? ` · ${a.preview}` : ""}`
      : `Subagent${a.goal ? `: ${a.goal}` : ""}${a.summary ? ` — ${a.summary}` : ""}`;
  const status = !a.done ? "running" : a.kind === "tool" && a.error ? "failed" : "done";
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 rounded-[10px] border border-dashed border-line px-3 text-left font-mono text-xs text-muted hover:bg-surface-2 dense:min-h-8"
      >
        {a.done ? <ToolIcon className="h-4 w-4 shrink-0" /> : <Spinner />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={cx("text-xs", status === "failed" && "text-danger")}>{status}</span>
      </button>
      {open && a.kind === "tool" ? (
        <div className="ml-9 mt-1 rounded-lg border border-line bg-surface-2 p-3 text-xs">
          <p className="text-muted">
            Started {formatTime(a.startedAt)}
            {a.durationSec !== undefined ? ` · ${a.durationSec.toFixed(2)}s` : ""}
          </p>
          {a.result ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{a.result}</pre> : null}
        </div>
      ) : null}
    </li>
  );
}

function LiveRun({ state, onApprove, onRetry }: { state: RunState; onApprove: (c: ApprovalRequest["choices"][number]) => void; onRetry: () => void }) {
  const who = useContext(AssistantName);
  const [busy, setBusy] = useState<string>();
  const text = state.text || (isTerminal(state.phase) ? (state.output ?? "") : "");
  return (
    <section aria-label="Current run" className="space-y-2">
      {state.activity.length ? (
        <ul className="space-y-1">
          {state.activity.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </ul>
      ) : null}

      {state.approval ? (
        <div role="group" aria-labelledby="approval-h" className="rounded-[12px] border-2 border-warn bg-warn-soft p-3.5">
          <h2 id="approval-h" className="font-semibold text-warn">
            Hermes needs your approval
          </h2>
          {state.approval.description ? <p className="mt-1 text-sm">{state.approval.description}</p> : null}
          {state.approval.command ? <pre className="mt-2 overflow-x-auto rounded-lg bg-surface p-2 text-xs">{state.approval.command}</pre> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {state.approval.choices.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={c === "deny" ? "danger" : c === "once" ? "primary" : "secondary"}
                busy={busy === c}
                disabled={Boolean(busy)}
                onClick={async () => {
                  setBusy(c);
                  await onApprove(c);
                  setBusy(undefined);
                }}
              >
                {c === "once" ? "Approve once" : c === "session" ? "Approve for this session" : c === "always" ? "Always allow" : "Deny"}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {text || (!isTerminal(state.phase) && state.phase !== "waiting_for_approval") ? (
        <div className="max-w-[95%] rounded-[12px] rounded-bl-[4px] border border-line bg-surface px-3.5 py-2.5">
          <span className="sr-only">{who} is saying: </span>
          {text ? <AssistantText text={text} live={!isTerminal(state.phase)} /> : null}
          {!isTerminal(state.phase) && state.phase !== "waiting_for_approval" ? (
            <p className="mt-1 flex items-center gap-1 text-muted" aria-hidden="true">
              <span className="typing-dot">●</span>
              <span className="typing-dot [animation-delay:0.2s]">●</span>
              <span className="typing-dot [animation-delay:0.4s]">●</span>
            </p>
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
  sessionId,
  phase,
  online,
  context,
  onRemoveContext,
  onAttach,
  onSend,
  onSteer,
  onStop,
  onCommand,
  repo: areaRepo,
  modelLabel,
  onModel,
  agent,
}: {
  sessionId: string;
  phase?: RunPhase;
  online: boolean;
  context: { label: string; ref: string }[];
  onRemoveContext: (ref: string) => void;
  onAttach: () => void;
  onSend: (text: string, key: string) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onStop: () => void;
  onCommand: (id: CommandId) => void;
  /** the area's default repo (the # picker's scope) */
  repo: string | null;
  modelLabel: string;
  onModel: () => void;
  /** who answers (Settings → Agents); shown when an agent is involved */
  agent?: AgentResolution | null;
}) {
  const who = useContext(AssistantName);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKey = useRef<string | undefined>(undefined);
  const ta = useRef<HTMLTextAreaElement>(null);
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
  const listId = useId();
  const { rows, loading, partial, searched } = useTriggerRows(trigger, repo);
  const activeIdx = Math.min(active, Math.max(0, rows.length - 1));

  // Drafts persist per session across refresh/navigation.
  useEffect(() => {
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
    const input = text.trim();
    if (!input || busy || !online) return;
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

  const placeholder = !online
    ? "Offline — drafts are saved, not sent"
    : phase === "waiting_for_approval"
      ? "Answer the approval first"
      : running
        ? "Add guidance…"
        : `Message ${who}…`;
  const open = !!trigger && (rows.length > 0 || loading || trigger.sigil !== "@" || trigger.query.length > 0);

  return (
    <div className="safe-bottom sticky bottom-[76px] z-20 border-t border-line bg-bg/95 px-4 py-2.5 backdrop-blur sm:bottom-0 sm:px-6">
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className="chip cursor-pointer hover:border-line-strong"
          onClick={onModel}
          aria-label={`Model: ${modelLabel}. Change`}
          data-testid="model-chip"
        >
          <span className="text-muted">Model</span> {modelLabel} <span aria-hidden="true">▾</span>
        </button>
        {agent && (agent.routed || agent.requested) ? <AgentChip agent={agent} /> : null}
        {context.map((c) => (
          <button key={c.ref} type="button" onClick={() => onRemoveContext(c.ref)} className="chip cursor-pointer" aria-label={`Remove context ${c.label}`}>
            {c.label} ✕
          </button>
        ))}
        <span className="ml-auto hidden text-[11px] text-muted lg:inline">
          <kbd className="kbd">@</kbd> reference · <kbd className="kbd">#</kbd> PR · <kbd className="kbd">/</kbd> command
        </span>
      </div>
      <form
        className="relative flex items-end gap-2"
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
        <Button type="button" variant="ghost" onClick={onAttach} aria-label="Attach context" className="shrink-0 px-3">
          +
        </Button>
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
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && running) {
              e.preventDefault();
              onStop();
            }
          }}
          className="block max-h-[200px] min-h-11 w-full resize-none rounded-[12px] border border-line-strong bg-surface px-3 py-2.5 text-base dense:min-h-10 dense:py-2 dense:text-[0.875rem]"
        />
        {running ? (
          <Button type="button" variant="secondary" onClick={onStop} aria-label="Stop the run (Escape)" disabled={phase === "stopping"} className="shrink-0">
            <StopIcon className="h-5 w-5" />
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!text.trim() || !online || phase === "waiting_for_approval" || phase === "stopping" || (running && !canSteer)}
          aria-label={running ? "Send guidance" : "Send"}
          className="shrink-0"
        >
          {!busy ? <SendIcon className="h-5 w-5" /> : null}
        </Button>
      </form>
      {!online && text ? <p className="mt-1 text-xs text-warn">Draft saved on this device. It has not been sent.</p> : null}
    </div>
  );
}
