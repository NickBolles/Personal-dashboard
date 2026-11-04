"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { relativeTime } from "@/lib/time";
import type { AgentResolution } from "@/lib/agents";
import type { SessionSummary, TimelineItem } from "@/lib/hermes";
import { AgentChip } from "@/components/agents/AgentChip";
import { Markdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/kit";
import { cx, inputCls, useToast } from "@/components/ui";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { ProposedQuickActions } from "@/components/quick-actions/ProposedQuickActions";
import { useQuickActions } from "@/components/quick-actions/useQuickActions";
import { COORDINATOR_PROMPT } from "@/lib/quick-actions";
import { useModKey } from "@/lib/client/platform";
import { composerKey, isSendShortcut, SEND_KEYSHORTCUTS, sendHint } from "@/lib/client/composer-keys";
import "./agents.css";

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

/** "Coordinator" button for an area (map card, area page). Opens the pane; sends nothing. */
export function CoordinatorButton({ areaId, areaTitle, className }: { areaId: string; areaTitle: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="coordinator-open">
        Coordinator
        <span className="sr-only"> chat for {areaTitle}</span>
      </Button>
      {open ? <CoordinatorPane areaId={areaId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The area's coordinator chat: side pane on desktop, bottom sheet on phones.
 * Shows the coordinator conversation's latest messages and a composer.
 * "Catch me up" only fills the composer with a prepared summary prompt; the
 * owner taps Send. Finance areas never get AI context.
 */
export function CoordinatorPane({ areaId, onClose }: { areaId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const mod = useModKey();
  const msgRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow with the text up to a max height, then scroll.
  useEffect(() => {
    const el = msgRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ["work", "coordinator", areaId],
    queryFn: () => api.get<CoordinatorResponse>(`/api/work/items/${encodeURIComponent(areaId)}/coordinator`),
  });
  const sid = sessionId ?? info.data?.sessionId ?? null;
  const detail = useQuery({
    queryKey: ["session", sid],
    queryFn: () => api.get<Detail>(`/api/hermes/sessions/${encodeURIComponent(sid!)}`),
    enabled: !!sid,
    refetchInterval: (q) => (q.state.data?.session?.activeRun ? 3000 : false),
  });

  // Escape closes; focus moves into the pane and returns to the opener on close.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A nested modal (Manage quick actions) owns Escape while it is open.
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restore?.focus?.();
    };
  }, []);

  const send = useMutation({
    mutationFn: async (input: string) => {
      let target = sid;
      if (!target) {
        // First message: the conversation is filed under the area, so it becomes the coordinator chat.
        const s = await api.post<SessionSummary>("/api/hermes/sessions", { title: `${info.data?.area.title ?? "Area"} coordinator`, areaId });
        target = s.id;
        setSessionId(s.id);
      }
      await api.post(`/api/hermes/sessions/${encodeURIComponent(target)}/runs`, {
        input,
        idempotencyKey: newIdempotencyKey("coord"),
        capabilities: [SMART_CAPABILITY],
      });
      return target;
    },
    onSuccess: (target) => {
      setText("");
      toast("Sent to the coordinator");
      void qc.invalidateQueries({ queryKey: ["session", target] });
      void qc.invalidateQueries({ queryKey: ["work", "coordinator", areaId] });
      void refreshSessionLists(qc).catch(() => undefined);
    },
    onError: (err) => toast(`Not sent: ${(err as Error).message}`, "danger"),
  });

  const d = info.data;
  const quickActions = useQuickActions(!!d && !d.excluded);
  const hasProposals = quickActions.data?.actions.some((a) => a.status === "proposed");
  const quickContext = { areaId, areaTitle: d?.area.title, path: typeof window !== "undefined" ? window.location.pathname : undefined };
  useEffect(() => {
    if (!d || d.excluded) return;
    const fill = (e: Event) => {
      const value = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof value === "string") {
        setText(value.slice(0, 8000));
        requestAnimationFrame(() => ref.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
      }
    };
    window.addEventListener(COORDINATOR_PROMPT, fill);
    return () => window.removeEventListener(COORDINATOR_PROMPT, fill);
  }, [d]);
  const msgs = (detail.data?.timeline ?? [])
    .filter((t): t is Extract<TimelineItem, { kind: "user" | "assistant" }> => t.kind === "user" || t.kind === "assistant")
    .slice(-6);
  return (
    <>
      <div className="co-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="false" aria-labelledby={titleId} className="co-pane" data-testid="coordinator-pane">
        <div className="co-head">
          <h2 id={titleId} className="min-w-0 flex-1 text-[15px] font-semibold [overflow-wrap:anywhere]">
            {d ? `${d.area.title} coordinator` : "Coordinator"}
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close coordinator chat">
            Close
          </Button>
          {d ? (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
              <AgentChip agent={d.agent} prefix="Answers" testId="coordinator-agent" />
              {d.lastRunAt ? <span data-dynamic>Last run {relativeTime(d.lastRunAt)}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="co-body" data-testid="coordinator-body">
          {info.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
          {info.error ? <p className="text-sm text-danger">Couldn&apos;t load the coordinator: {(info.error as Error).message}</p> : null}
          {d?.excluded ? (
            <p className="text-sm" data-testid="coordinator-excluded">
              Finance stays out of AI: this area has no coordinator chat.
            </p>
          ) : null}
          {d && !d.excluded && !sid ? (
            <div className="grid min-w-0 gap-2">
              <p className="text-sm text-muted" data-testid="coordinator-empty">
                No coordinator conversation yet. Your first message starts one, filed in this area.
              </p>
              <QuickActionChips variant="empty" context={quickContext} onPrompt={setText} />
            </div>
          ) : null}
          {sid && msgs.length ? (
            <ol aria-label="Latest messages">
              {msgs.map((m) => (
                <li key={m.id} className="co-msg">
                  <p className="text-xs font-semibold text-muted">{m.kind === "user" ? "You" : "Coordinator"}</p>
                  {m.kind === "assistant" ? (
                    <Markdown text={m.text} />
                  ) : (
                    <p className="whitespace-pre-wrap">{m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : sid && detail.isSuccess ? (
            <p className="text-sm text-muted">No messages yet.</p>
          ) : null}
          {detail.data?.session?.activeRun ? <p className="mt-2 text-xs text-muted">The coordinator is working…</p> : null}
          {sid ? (
            <Link href={`/chat/${encodeURIComponent(sid)}`} className="mt-2 inline-block text-xs text-accent hover:underline">
              Open full conversation
            </Link>
          ) : null}
        </div>
        {d && !d.excluded ? (
          <>
            <ProposedQuickActions />
            <form
              className="co-foot"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim() && !send.isPending) send.mutate(text.trim());
              }}
            >
              <QuickActionChips variant="row" context={quickContext} onPrompt={setText} />
              <label htmlFor={`${titleId}-m`} className="sr-only">
                Message the coordinator
              </label>
              <textarea
                id={`${titleId}-m`}
                data-autofocus
                data-testid="coordinator-input"
                ref={msgRef}
                className={cx(inputCls, "max-h-60 min-h-[72px] w-full min-w-0 resize-none overflow-y-auto text-[16px] sm:text-sm")}
                rows={3}
                maxLength={8000}
                value={text}
                placeholder="Ask the coordinator…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter is a newline; Ctrl/⌘ + Enter sends (same as the Send button).
                  if (isSendShortcut(composerKey(e))) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
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
                  title={`Send (${sendHint(mod)})`}
                  aria-keyshortcuts={SEND_KEYSHORTCUTS}
                >
                  Send
                </Button>
              </div>
            </form>
          </>
        ) : null}
      </div>
    </>
  );
}
