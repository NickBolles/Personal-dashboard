"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { isOpsConversation } from "@/lib/coordinator/thread";
import { Button, useToast } from "@/components/ui";

/** Pins the area's coordinator thread (null = unpin). Refreshes the coordinator info so every surface follows. */
export function usePinThread(areaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string | null) =>
      api.put<{ sessionId: string | null; pinned: boolean; previous: string | null }>(`/api/work/items/${encodeURIComponent(areaId)}/coordinator`, {
        sessionId,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["work", "coordinator"] }),
  });
}

type Earlier = { id: string; title: string };

/**
 * The coordinator thread's header row: earlier threads (opened here, in the panel), "New thread" behind a confirm with
 * Undo, and — while an earlier thread is open — the way back or "Use this thread". Everything that changes which
 * thread the Chief of staff talks in goes through the pin (one setting per area); nothing here sends a message.
 */
export function ThreadBar({
  areaId,
  current,
  pinned,
  viewing,
  viewingTitle,
  fresh,
  busy,
  earlier,
  earlierState,
  onEarlierOpen,
  onOpen,
  onNew,
  onUndoNew,
}: {
  areaId: string;
  /** the Chief of staff thread (pinned or picked) */
  current: string | null;
  /** whether `current` is pinned (else the newest-conversation rule picked it): Undo restores exactly that */
  pinned: boolean;
  /** the thread on screen (an earlier one, the current one, or null while a new thread waits for its first message) */
  viewing: string | null;
  viewingTitle: string | null;
  fresh: boolean;
  busy: boolean;
  earlier: Earlier[];
  earlierState: "idle" | "loading" | "error" | "ready";
  onEarlierOpen: (open: boolean) => void;
  /** show a thread in the panel (null = back to the current thread) */
  onOpen: (sessionId: string | null) => void;
  onNew: () => void;
  onUndoNew: () => void;
}) {
  const { toast } = useToast();
  const pin = usePinThread(areaId);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  /** What Undo restores: the previous pin (null = no pin, back to the newest-conversation rule). */
  const [undo, setUndo] = useState<{ pin: string | null } | null>(null);
  const onEarlierThread = !!viewing && !!current && viewing !== current && !fresh;
  const list = earlier.filter((c) => c.id !== viewing && !isOpsConversation(c)).slice(0, 8);
  return (
    <div className="gc-threadbar mb-2 text-xs" data-testid="gc-threadbar">
      {onEarlierThread ? (
        <div className="gc-thread-earlier flex flex-wrap items-center gap-1" role="group" aria-label="Earlier thread">
          <span className="min-w-0 flex-1 truncate text-muted" data-dynamic>
            Earlier thread{viewingTitle ? `: ${viewingTitle}` : ""}
          </span>
          <Button size="sm" variant="ghost" disabled={switching} onClick={() => setSwitching(true)}>
            Use this thread
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpen(null)}>
            Back to current
          </Button>
        </div>
      ) : null}
      {onEarlierThread && switching ? (
        <div className="gc-thread-confirm flex flex-wrap items-center gap-1" role="group" aria-label="Make this the Chief of staff thread?">
          <span className="min-w-0 flex-1">Make this the Chief of staff thread? New messages from the rail and tray go here.</span>
          <Button
            size="sm"
            variant="primary"
            loading={pin.isPending}
            onClick={() =>
              pin.mutate(viewing, {
                // The panel stays on this thread; it becomes the current one when the coordinator info refreshes.
                onSuccess: (res) => {
                  setSwitching(false);
                  setUndo({ pin: res.previous });
                },
                onError: (e) => toast(`Not changed: ${(e as Error).message}`, "danger"),
              })
            }
          >
            Use this thread
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSwitching(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <div className="gc-thread-confirm flex flex-wrap items-center gap-1" role="group" aria-label="Start a new thread?">
          <span className="min-w-0 flex-1">Start a new thread? This one moves to Earlier threads.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setConfirming(false);
              setUndo({ pin: pinned ? current : null });
              onNew();
            }}
          >
            Start new thread
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {undo && !confirming ? (
        <p className="gc-thread-undo flex flex-wrap items-center gap-1" role="status">
          <span className="min-w-0 flex-1">{fresh ? "New thread: your next message starts it." : "Thread changed."}</span>
          <Button
            size="sm"
            variant="ghost"
            loading={pin.isPending}
            onClick={() => {
              const back = undo.pin;
              setUndo(null);
              if (fresh) return onUndoNew();
              pin.mutate(back, {
                onSuccess: (res) => onOpen(back ?? res.sessionId),
                onError: (e) => toast(`Not undone: ${(e as Error).message}`, "danger"),
              });
            }}
          >
            Undo
          </Button>
        </p>
      ) : null}
      <details className="gc-thread-list" onToggle={(event) => onEarlierOpen(event.currentTarget.open)}>
        <summary className="min-h-6 cursor-pointer text-muted">Earlier threads</summary>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy || fresh || confirming} onClick={() => setConfirming(true)}>
            New thread
          </Button>
          {earlierState === "loading" ? <span className="text-muted">Loading threads…</span> : null}
          {earlierState === "error" ? <span role="alert">Couldn&apos;t load earlier threads.</span> : null}
          {earlierState === "ready" && !list.length ? <span className="text-muted">No earlier threads.</span> : null}
        </div>
        {list.length ? (
          <ul aria-label="Earlier threads">
            {list.map((c) => (
              <li key={c.id}>
                <Button size="sm" variant="ghost" className="gc-thread-open max-w-full justify-start" onClick={() => onOpen(c.id)}>
                  <span className="truncate">{c.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}
