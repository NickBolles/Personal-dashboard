"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { AgentChip } from "@/components/agents/AgentChip";
import { Button, CoordinatorGlyph, IconAction } from "@/components/ui";
import { useAgentRuns } from "@/components/agents/AgentRuns";
import { coordinatorDot, coordinatorEntries } from "@/lib/agent-runs";
import { CoordinatorThread, type CoordinatorResponse } from "@/components/coordinator/CoordinatorThread";
import "./agents.css";

export type { CoordinatorResponse } from "@/components/coordinator/CoordinatorThread";

/**
 * Coordinator entry for an area (map card, area page, Chief of staff slot): a compact ✦ icon
 * button (N5) with a tooltip and a live dot (working / waiting for you / failed) from the
 * shared agent-runs poll. Opens the pane; sends nothing.
 */
export function CoordinatorButton({ areaId, areaTitle, className }: { areaId: string; areaTitle: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const dot = coordinatorDot(coordinatorEntries(useAgentRuns().data, areaId));
  return (
    <>
      <IconAction
        label={`Coordinator chat for ${areaTitle}`}
        icon={<CoordinatorGlyph />}
        dot={dot}
        className={className}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-testid="coordinator-open"
      />
      {open ? <CoordinatorPane areaId={areaId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The area's coordinator chat: side pane on desktop, bottom sheet on phones.
 * Shows the coordinator conversation's latest messages and a composer.
 * "Catch me up" only fills the composer with a prepared summary prompt; the
 * owner taps Send. AI-excluded areas never get AI context.
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
          <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold [overflow-wrap:anywhere]">
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
