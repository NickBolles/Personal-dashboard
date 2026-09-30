"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { kvDel, kvGet, kvSet, rememberSession } from "@/lib/client/idb";
import type { EntityLink } from "@/lib/contracts";
import { isTerminal, toolLabel, type ApprovalRequest, type RunPhase, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { formatTime } from "@/components/actions/format";
import { Badge, Button, ErrorNote, OverflowMenu, Spinner, cx, useOnline, useToast, type Tone } from "@/components/ui";
import { ChevronIcon, ForkIcon, SendIcon, StopIcon, ToolIcon } from "@/components/icons";
import { useRunStream, type Activity, type RunState } from "./useRunStream";
import { ContextPicker, ForkDialog, ModelDialog, RenameDialog, TrackDialog } from "./dialogs";

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
  const { detail, error, refetch, fromCache, isLoading } = useSessionDetail(sessionId);
  const [pendingInput, setPendingInput] = useState<string>();
  const [dialog, setDialog] = useState<null | "rename" | "fork" | "track" | "model" | "context">(null);
  const [forkFrom, setForkFrom] = useState<TimelineItem>();
  const [model, setModel] = useState<{ model?: string; provider?: string }>({});
  const [context, setContext] = useState<{ label: string; ref: string }[]>([]);
  const [lastOutcome, setLastOutcome] = useState<RunPhase>();
  const clearRunRef = useRef<() => void>(() => {});

  const onTerminal = useCallback(
    (s: RunState) => {
      announce(s.phase === "completed" ? "Hermes finished responding" : `Run ${PHASE_LABEL[s.phase].label.toLowerCase()}`);
      setLastOutcome(s.phase);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["home"] });
      // Once the durable transcript includes this turn, drop the live copy (keeps failure notices).
      qc.refetchQueries({ queryKey: ["session", sessionId] }).then(() => {
        setPendingInput(undefined);
        if (s.phase === "completed") clearRunRef.current();
      });
    },
    [announce, qc, sessionId],
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
        ...model,
      });
      await kvDel(`pending:${sessionId}`);
      setContext([]);
      announce("Message sent. Hermes is responding.");
      run.start(r.runId);
      qc.invalidateQueries({ queryKey: ["sessions"] });
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
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast(msg, "ok");
    } catch (err) {
      toast((err as Error).message, "danger");
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
  const showLive = Boolean(run.state.runId) && (liveActive || run.state.phase !== "completed" || Boolean(run.state.text) || run.state.activity.length > 0);
  const lastUser = [...detail.timeline].reverse().find((t) => t.kind === "user");
  const showPendingUser = pendingInput && !(lastUser && "text" in lastUser && lastUser.text.startsWith(pendingInput.slice(0, 40)));

  const menu = [
    { label: "Rename", onSelect: () => setDialog("rename") },
    { label: "Fork latest state", onSelect: () => (setForkFrom(undefined), setDialog("fork")), disabled: !online },
    { label: "Model…", onSelect: () => setDialog("model") },
    { label: "Track in Paperclip", onSelect: () => setDialog("track"), disabled: !online },
    {
      label: session!.pinned ? "Unpin" : "Pin",
      onSelect: () => patch({ pinned: !session!.pinned }, session!.pinned ? "Unpinned" : "Pinned"),
      disabled: !online,
    },
    {
      label: session!.archived ? "Unarchive" : "Archive",
      onSelect: () => patch({ archived: !session!.archived }, session!.archived ? "Restored" : "Archived"),
      disabled: !online,
    },
    {
      label: "Copy link",
      onSelect: () => {
        navigator.clipboard?.writeText(window.location.origin + `/chat/${encodeURIComponent(sessionId)}`).then(() => toast("Link copied", "ok"));
      },
    },
  ];

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-76px)] max-w-3xl flex-col lg:min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex items-start gap-2">
          <Link href="/chat" className="tap -ml-2 inline-flex items-center justify-center rounded-xl text-muted lg:hidden" aria-label="Back to conversations">
            <ChevronIcon className="h-5 w-5 rotate-180" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{session!.title}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              {phase ? <Badge tone={PHASE_LABEL[phase].tone}>{PHASE_LABEL[phase].label}</Badge> : null}
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
                <Link key={l.targetId} href="/initiatives" data-dynamic className="rounded-full border border-line px-2 py-0.5 font-mono" title={l.targetTitle}>
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

      <div className="flex-1 space-y-4 px-4 py-4 sm:px-6" aria-label="Conversation timeline">
        {detail.timeline.length === 0 && !showLive && !pendingInput ? (
          <p className="py-10 text-center text-muted">Say hello to start the conversation.</p>
        ) : null}
        <ol className="space-y-4">
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
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-contrast">
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
      />

      <RenameDialog open={dialog === "rename"} onClose={() => setDialog(null)} session={session!} />
      <ForkDialog open={dialog === "fork"} onClose={() => setDialog(null)} session={session!} fromMessage={forkFrom} />
      <TrackDialog open={dialog === "track"} onClose={() => setDialog(null)} session={session!} />
      <ModelDialog
        open={dialog === "model"}
        onClose={() => setDialog(null)}
        value={model}
        onChange={(m) => {
          setModel(m);
          kvSet(`model:${sessionId}`, m);
        }}
      />
      <ContextPicker
        open={dialog === "context"}
        onClose={() => setDialog(null)}
        onPick={(label, ref) => setContext((c) => (c.some((x) => x.ref === ref) ? c : [...c, { label, ref }]))}
      />
    </div>
  );
}

function TimelineRow({ item, onFork }: { item: TimelineItem; onFork: () => void }) {
  const [open, setOpen] = useState(false);
  const time = item.at ? formatTime(item.at) : undefined;
  if (item.kind === "user") {
    return (
      <li className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-contrast">
          <span className="sr-only">You said: </span>
          <p className="prose-chat select-text">{item.text}</p>
        </div>
        <MessageMeta time={time} onFork={onFork} who="your message" />
      </li>
    );
  }
  if (item.kind === "assistant") {
    return (
      <li className="flex flex-col gap-1">
        <div className="max-w-[95%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3">
          <span className="sr-only">Hermes said: </span>
          <p className="prose-chat select-text">{item.text}</p>
        </div>
        <MessageMeta time={time} onFork={onFork} who="Hermes' message" />
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
          className={cx("flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm text-muted hover:bg-surface-2", item.error && "text-danger")}
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

function MessageMeta({ time, onFork, who }: { time?: string; onFork: () => void; who: string }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted">
      {time ? <span>{time}</span> : null}
      <button
        type="button"
        onClick={onFork}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 hover:bg-surface-2"
        aria-label={`Fork from ${who}${time ? ` at ${time}` : ""}`}
      >
        <ForkIcon className="h-3.5 w-3.5" /> Fork from here
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
        className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm text-muted hover:bg-surface-2"
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
        <div role="group" aria-labelledby="approval-h" className="rounded-2xl border-2 border-warn bg-warn-soft p-4">
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
        <div className="max-w-[95%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3">
          <span className="sr-only">Hermes is saying: </span>
          {text ? <p className="prose-chat select-text">{text}</p> : null}
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
          Connection dropped — reconnecting and checking Hermes for the real status…
        </p>
      ) : null}
      {state.phase === "disconnected" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <span>{state.error ?? "Disconnected from Hermes."} The run may still be going.</span>
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
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pendingKey = useRef<string | undefined>(undefined);
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = phase !== undefined && !isTerminal(phase);
  const canSteer = phase === "running";

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

  const submit = async () => {
    const input = text.trim();
    if (!input || busy || !online) return;
    setBusy(true);
    let ok: boolean;
    if (running) {
      ok = canSteer ? await onSteer(input) : false;
    } else {
      const key = pendingKey.current ?? newIdempotencyKey("run");
      pendingKey.current = key;
      ok = await onSend(input, key);
      if (ok) pendingKey.current = undefined;
    }
    if (ok) {
      setText("");
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
        : "Message Hermes";

  return (
    <div className="safe-bottom sticky bottom-[76px] z-20 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:px-6 lg:bottom-0">
      {context.length ? (
        <ul className="mb-2 flex flex-wrap gap-1" aria-label="Attached context">
          {context.map((c) => (
            <li key={c.ref}>
              <button
                type="button"
                onClick={() => onRemoveContext(c.ref)}
                className="min-h-9 rounded-full border border-line px-3 text-xs"
                aria-label={`Remove context ${c.label}`}
              >
                {c.label} ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Button type="button" variant="ghost" onClick={onAttach} aria-label="Attach context" className="shrink-0 px-3">
          +
        </Button>
        <label htmlFor="composer" className="sr-only">
          {running ? "Guidance for the current run" : "Message Hermes"}
        </label>
        <textarea
          id="composer"
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && running) {
              e.preventDefault();
              onStop();
            }
          }}
          className="block max-h-[200px] min-h-12 w-full resize-none rounded-[10px] border border-line-strong bg-surface px-3 py-3 text-base"
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
