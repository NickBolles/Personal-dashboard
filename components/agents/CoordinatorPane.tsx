"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { AgentChip } from "@/components/agents/AgentChip";
import { Button } from "@/components/ui/kit";
import { CoordinatorThread, type CoordinatorResponse } from "@/components/coordinator/CoordinatorThread";
import "./agents.css";

export type { CoordinatorResponse } from "@/components/coordinator/CoordinatorThread";

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
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const info = useQuery({
    queryKey: ["work", "coordinator", areaId],
    queryFn: () => api.get<CoordinatorResponse>(`/api/work/items/${encodeURIComponent(areaId)}/coordinator`),
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

  const d = info.data;
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
        {info.isLoading ? <p className="co-body text-sm text-muted">Loading…</p> : null}
        {info.error ? <p className="co-body text-sm text-danger">Couldn&apos;t load the coordinator: {(info.error as Error).message}</p> : null}
        {d ? <CoordinatorThread key={areaId} info={d} /> : null}
      </div>
    </>
  );
}
