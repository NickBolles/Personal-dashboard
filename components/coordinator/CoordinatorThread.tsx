"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { AgentResolution } from "@/lib/agents";
import { maskedNotice, type RunView, type SessionSummary, type TimelineItem } from "@/lib/hermes";
import { Markdown } from "@/components/markdown/Markdown";
import { RateMessage } from "@/components/feedback/RateMessage";
import { Button, cx, useToast } from "@/components/ui";
import { inputCls } from "@/components/ui/legacy";
import { composerKey, isSendShortcut } from "@/lib/client/composer-keys";
import { withPageContext, type PageContext } from "@/lib/coordinator/page-context";
import { COORDINATOR_PROMPT, type QuickActionContext } from "@/lib/quick-actions";
import { QuickActionChips } from "@/components/quick-actions/QuickActionChips";
import { ProposedQuickActions } from "@/components/quick-actions/ProposedQuickActions";
import { useQuickActions } from "@/components/quick-actions/useQuickActions";
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
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!compact) textarea.current?.focus();
  }, [compact]);
  const sid = sessionId ?? d.sessionId;
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
  const send = useMutation({
    mutationFn: async (input: string) => {
      let target = sid;
      if (!target) {
        const s = await api.post<SessionSummary>("/api/hermes/sessions", { title: `${d.area.title} coordinator`, areaId: d.area.id });
        target = s.id;
        setSessionId(s.id);
      }
      const run = await api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(target)}/runs`, {
        input: compact ? withPageContext(input, context) : input,
        idempotencyKey: newIdempotencyKey("coord"),
        capabilities: [SMART_CAPABILITY],
      });
      return { target, notice: maskedNotice(run) };
    },
    onSuccess: ({ target, notice }) => {
      setText("");
      if (textarea.current && compact) textarea.current.style.height = "auto";
      toast(notice ?? "Sent to the coordinator", notice ? "warn" : undefined);
      void qc.invalidateQueries({ queryKey: ["session", target] });
      void qc.invalidateQueries({ queryKey: ["work", "coordinator"] });
      void refreshSessionLists(qc).catch(() => undefined);
    },
    onError: (err) => toast(`Not sent: ${(err as Error).message}`, "danger"),
  });
  const submit = () => {
    if (text.trim() && !send.isPending && !d.excluded) send.mutate(text.trim());
  };
  const timeline = detail.data?.timeline ?? [];
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
                              if (detail.data?.session.activeRun) {
                                toast("Wait for the coordinator to finish, then ask again.", "warn");
                                return false;
                              }
                              await send.mutateAsync(prompt);
                              return true;
                            }}
                          />
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs font-semibold text-muted">{m.kind === "user" ? "You" : "Coordinator"}</p>
                    )}
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
