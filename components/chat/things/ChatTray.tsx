"use client";
import { Button } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { trayContent, type ChatThings, type ThingsTab } from "@/lib/chat/things";
import { SummaryChip, ThingIcon } from "./SummaryChip";

/**
 * The strip above the composer. It exists only while it has something to say (lib/chat/things `trayContent`):
 * a status line while something is failing, waiting on the owner, finished-unread or running; chips for the
 * things this chat actually has (never a zero or an unknown "—"); and a plain "couldn't check" note with Retry
 * when the background-work check failed and that matters here. An idle chat renders nothing, so the thread
 * gets the room. The chat panel itself is always reachable from the conversation header.
 */
export function ChatTray({
  things,
  onOpen,
  onRetry,
  compact,
  accessory,
}: {
  things: ChatThings;
  onOpen: (tab: ThingsTab) => void;
  /** re-run the background-work check */
  onRetry?: () => void;
  compact?: boolean;
  accessory?: React.ReactNode;
}) {
  const { status, chips, notice, empty } = trayContent(things);
  const { workflow } = things;
  if (empty && !accessory) return null;
  return (
    <div
      className="chat-tray"
      data-testid="chat-tray"
      data-compact={compact || undefined}
      // The tray sits in the composer dock: on phones a focused textarea hides the bottom nav, so letting
      // a tap blur it shifts the dock between pointerdown and click and the tap is lost. Keep focus there.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button") && document.activeElement instanceof HTMLTextAreaElement) e.preventDefault();
      }}
    >
      {status ? (
        <button
          type="button"
          className="chat-tray-line min-h-11 sm:min-h-10 dense:min-h-8"
          data-tone={status.tone}
          data-state={status.state}
          data-testid="chat-tray-status"
          onClick={() => onOpen(status.tab)}
        >
          <span className="relative shrink-0">
            <ThingIcon kind={status.tab} spinning={status.state === "running"} />
            {status.dot ? <span className="chat-attention-dot" data-dot={status.dot} /> : null}
          </span>
          <strong>{status.label}</strong>
          <span className="min-w-0 flex-1 truncate text-left">{status.text}</span>
          {status.action ? <span className="chat-tray-action">{status.action}</span> : <span className="sr-only">Show details</span>}
          <ChevronIcon className="h-3.5 w-3.5 shrink-0 -rotate-90" />
        </button>
      ) : null}
      {notice ? (
        <p className="chat-tray-note" role="status" data-testid="chat-tray-note">
          <span className="min-w-0">Couldn&apos;t check background work</span>
          {onRetry ? (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}
      {(workflow ? workflow.sections.length : chips.length) ? (
        <div className="chat-tray-counts" data-scroll-x>
          {workflow
            ? workflow.sections.map((s) => (
                <SummaryChip key={s.title} kind="Outline" count={s.count} onClick={() => onOpen("Outline")}>
                  {s.title}
                </SummaryChip>
              ))
            : chips.map((c) => <SummaryChip key={c.tab} kind={c.tab} count={c.count} tone={c.tone} dot={c.dot} onClick={() => onOpen(c.tab)} />)}
        </div>
      ) : null}
      {accessory}
    </div>
  );
}
