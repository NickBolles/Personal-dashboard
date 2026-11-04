"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { AgentResolution } from "@/lib/agents";
import type { SessionSummary, TimelineItem } from "@/lib/hermes";
import { Markdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/kit";
import { cx, inputCls, useToast } from "@/components/ui";
import { isSendShortcut } from "@/lib/coordinator/send-shortcut";
import { withPageContext, type PageContext } from "@/lib/coordinator/page-context";
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
export type QuickActionsSlot = (onPrompt: (text: string) => void) => ReactNode;

/** Shared thread + send mutation. Area variant preserves its labels, testids and composer. */
export function CoordinatorThread({
  info: d,
  compact = false,
  context = null,
  onRemoveContext,
  draft,
  onDraft,
  inlineActions,
  quickActions,
}: {
  info: CoordinatorResponse;
  compact?: boolean;
  context?: PageContext | null;
  onRemoveContext?: () => void;
  draft?: string;
  onDraft?: (text: string) => void;
  inlineActions?: (lastUserAt: string | null) => ReactNode;
  quickActions?: QuickActionsSlot;
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
      await api.post(`/api/hermes/sessions/${encodeURIComponent(target)}/runs`, {
        input: compact ? withPageContext(input, context) : input,
        idempotencyKey: newIdempotencyKey("coord"),
        capabilities: [SMART_CAPABILITY],
      });
      return target;
    },
    onSuccess: (target) => {
      setText("");
      if (textarea.current && compact) textarea.current.style.height = "auto";
      toast("Sent to the coordinator");
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
      <div className={compact ? "gc-thread-body" : "co-body"} data-testid={compact ? "gc-thread-body" : "coordinator-body"}>
        {d.excluded ? (
          <p className="text-sm" data-testid="coordinator-excluded">
            Finance stays out of AI: this area has no coordinator chat.
          </p>
        ) : (
          <>
            {!sid ? (
              <div>
                <p className="text-sm text-muted" data-testid={compact ? "gc-empty" : "coordinator-empty"}>
                  No coordinator conversation yet. Your first message starts one, filed in this area.
                </p>
                {/* quick-actions slot */}
                {compact ? quickActions?.(setText) : null}
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
            {!sid || detail.isSuccess ? inlineActions?.(lastUser?.at ?? null) : null}
          </>
        )}
      </div>
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
          {/* quick-actions slot */}
          {compact ? quickActions?.(setText) : null}
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
                if (compact && isSendShortcut({ ...e, isComposing: e.nativeEvent.isComposing })) {
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
              <Button type="submit" size="sm" variant="primary" disabled={!text.trim()} loading={send.isPending} data-testid="coordinator-send">
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
