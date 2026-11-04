"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import type { ChatNotice, NoticeTask } from "@/lib/chat-notices";

/**
 * Hermes control frames (async delegation results, background-process notices) as one
 * collapsed row: title · status · duration. Expanding shows each task's summary (itself
 * collapsed) and its transcript path as copyable text — a host path, never a link.
 */
export function NoticeCard({ notice, time }: { notice: Extract<ChatNotice, { kind: "delegation" | "process" }>; time?: string }) {
  const tone =
    notice.kind === "delegation" ? (notice.status === "completed" ? "ok" : notice.status === "partial" ? "warn" : "danger") : notice.ok ? "ok" : "danger";
  const status = notice.kind === "delegation" ? notice.status : notice.status;
  const duration = notice.kind === "delegation" ? notice.duration : undefined;
  return (
    <details className="chat-notice" data-testid="chat-notice" data-notice={notice.kind}>
      <summary>
        <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full", tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-danger")} />
        <span className="min-w-0 flex-1 truncate font-medium">{notice.title}</span>
        <span className={cx("shrink-0 text-xs tabular-nums", tone === "danger" ? "text-danger" : "text-muted")} data-dynamic>
          {[status, duration, time].filter(Boolean).join(" · ")}
        </span>
        <ChevronIcon className="notice-chev h-4 w-4 shrink-0 text-muted" />
      </summary>
      <div className="chat-notice-body">
        {notice.kind === "delegation" ? (
          notice.tasks.length ? (
            notice.tasks.map((t) => <TaskRow key={`${t.index}-${t.goal ?? ""}`} task={t} />)
          ) : (
            <Raw text={notice.detail} />
          )
        ) : (
          <>
            {notice.command ? (
              <p className="text-xs text-muted">
                Command: <code className="[overflow-wrap:anywhere]">{notice.command}</code>
              </p>
            ) : null}
            {notice.output ? (
              <pre className="max-h-48 overflow-auto rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap break-words">{notice.output}</pre>
            ) : null}
            {!notice.command && !notice.output ? <Raw text={notice.detail} /> : null}
          </>
        )}
        {notice.kind === "delegation" && notice.id ? <p className="text-xs text-muted">Batch {notice.id}</p> : null}
      </div>
    </details>
  );
}

function TaskRow({ task }: { task: NoticeTask }) {
  return (
    <details className="chat-notice-task" data-testid="notice-task">
      <summary>
        <span aria-hidden="true" className={task.ok ? "text-ok" : "text-danger"}>
          {task.ok ? "✓" : "✗"}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {task.total && task.total > 1 ? `${task.index}/${task.total} · ` : ""}
          {task.goal || "Task"}
        </span>
        <span className={cx("shrink-0 text-xs tabular-nums", task.ok ? "text-muted" : "text-danger")} data-dynamic>
          {[task.status, task.duration].filter(Boolean).join(" · ")}
        </span>
      </summary>
      <div className="space-y-1.5 px-2 pb-2">
        {task.body ? (
          <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap break-words">{task.body}</pre>
        ) : (
          <p className="text-xs text-muted">No summary.</p>
        )}
        {task.transcript ? <TranscriptPath path={task.transcript} /> : null}
      </div>
    </details>
  );
}

/** The transcript lives on the agent host: show the path to copy, never a link. */
function TranscriptPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
      <span className="shrink-0">Full transcript</span>
      <code className="chat-notice-path min-w-0 flex-1" data-testid="transcript-path">
        {path}
      </code>
      <button
        type="button"
        className="inline-flex min-h-11 items-center rounded-[6px] px-2 hover:bg-surface sm:min-h-8 dense:min-h-7"
        onClick={() =>
          navigator.clipboard
            ?.writeText(path)
            .then(() => setCopied(true))
            .catch(() => {})
        }
        aria-label="Copy transcript path"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Raw({ text }: { text: string }) {
  return <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap break-words">{text}</pre>;
}

/** "Earlier conversation summarized": a thin divider; the summary is one tap away. */
export function CompactionDivider({ summary }: { summary: string }) {
  return (
    <div className="chat-compaction" data-testid="chat-compaction">
      <details>
        <summary>Earlier conversation summarized</summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-line bg-surface p-2 text-left text-xs whitespace-pre-wrap break-words text-text">
          {summary}
        </pre>
      </details>
    </div>
  );
}
