"use client";
import { ChevronIcon } from "@/components/icons";
import type { ChatThings, ThingsTab } from "@/lib/chat/things";
import { SummaryChip, ThingIcon } from "./SummaryChip";
export function ChatTray({
  things,
  onOpen,
  compact,
  accessory,
}: {
  things: ChatThings;
  onOpen: (tab: ThingsTab) => void;
  compact?: boolean;
  accessory?: React.ReactNode;
}) {
  const { counts, line, workflow } = things;
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
      <button
        type="button"
        className="chat-tray-line min-h-11 sm:min-h-10 dense:min-h-8"
        data-tone={line.tone}
        onClick={() => onOpen(line.tab)}
        aria-label="Open chat panel"
      >
        <span className="relative shrink-0">
          <ThingIcon kind={line.tab} spinning={line.state === "running"} />
          {line.dot ? <span className="chat-attention-dot" data-dot={line.dot} /> : null}
        </span>
        <strong>{line.label}</strong>
        <span className="min-w-0 flex-1 truncate text-left">{line.text}</span>
        {line.action ? <span className="chat-tray-action">{line.action}</span> : null}
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 -rotate-90" />
      </button>
      <div className="chat-tray-counts" data-scroll-x>
        {workflow ? (
          workflow.sections.map((s) => (
            <SummaryChip key={s.title} kind="Outline" count={s.count} onClick={() => onOpen("Outline")}>
              {s.title}
            </SummaryChip>
          ))
        ) : (
          <>
            <SummaryChip
              kind="PRs"
              count={counts.prs.total}
              tone={counts.prs.failing ? "bad" : "neutral"}
              dot={counts.prs.failing ? "red" : null}
              onClick={() => onOpen("PRs")}
            />
            <SummaryChip kind="Running" count={counts.running} tone={counts.running ? "ai" : "neutral"} onClick={() => onOpen("Running")} />
            <SummaryChip kind="Artifacts" count={counts.artifacts} onClick={() => onOpen("Artifacts")} />
            <SummaryChip kind="Files" count={counts.files} onClick={() => onOpen("Files")} />
            <SummaryChip kind="Context" count={counts.context} tone="ai" onClick={() => onOpen("Context")} />
          </>
        )}
        <button
          type="button"
          className="min-h-11 min-w-11 shrink-0 sm:min-h-10 dense:min-h-8"
          aria-label="Show chat tabs"
          onClick={() => onOpen(workflow ? "Outline" : "Links")}
        >
          <ChevronIcon className="mx-auto h-4 w-4 -rotate-90" />
        </button>
      </div>
      {accessory}
    </div>
  );
}
