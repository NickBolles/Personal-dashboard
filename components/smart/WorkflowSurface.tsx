"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/client/api";
import type { WorkflowKind, WorkflowResponse } from "@/lib/jarvis-ui/types";
import { Button, ButtonLink, ErrorNote, Spinner, useToast } from "@/components/ui";
import { chatHref } from "@/components/home/chat";
import { useSmartSettings } from "./AssistantText";
import { SmartSurface } from "./SmartSurface";

const ASK: Partial<Record<WorkflowKind, { context: string; draft: string; label: string }>> = {
  brief: {
    context: "@ctx:morning_brief",
    draft: "Give me my morning brief: what's worth doing today, and anything I should snooze or skip.",
    label: "Ask Hermes for a brief",
  },
  week: {
    context: "@ctx:week_plan",
    draft: "Plan my week: place my tasks into time blocks around my calendar.",
    label: "Ask Hermes to plan",
  },
};

/**
 * A Jarvis-built workflow surface (no model): fetched from
 * POST /api/smart/workflows and rendered like any smart reply, with the
 * same tray, Apply and undo. "Rebuild" starts over from current data.
 */
export function WorkflowSurface({ kind, prRef, compact = false }: { kind: WorkflowKind; prRef?: string; compact?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const settings = useSmartSettings();
  // The local day is part of the identity, so a page left open past midnight (or a week
  // boundary) asks the server again, which picks that period's surface.
  const day = new Date().toLocaleDateString("en-CA");
  const key = ["smart-workflow", kind, prRef ?? "", kind === "pr" ? "" : day];
  const enabled = settings.data?.enabled === true;
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.post<WorkflowResponse>("/api/smart/workflows", { kind, ...(prRef ? { ref: prRef } : {}) }),
    enabled,
    // Refetching returns the stored surface for the period (same builtAt, no remount), so focus refetches are cheap.
    staleTime: 5 * 60_000,
  });
  const rebuild = useMutation({
    mutationFn: () => api.post<WorkflowResponse>("/api/smart/workflows", { kind, ...(prRef ? { ref: prRef } : {}), rebuild: true }),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      qc.invalidateQueries({ queryKey: ["smart-hydrate"] });
      toast("Rebuilt from current data", "ok");
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't rebuild", "danger"),
  });
  if (settings.isPending) return <Spinner label="Loading…" />;
  if (!enabled)
    return (
      <p className="rounded-[10px] border border-dashed border-line-strong px-3 py-4 text-sm text-muted" data-testid="workflow-off">
        This view uses Smart replies, which are off.{" "}
        <Link href="/settings" className="text-accent underline">
          Turn them on in Settings
        </Link>
        .
      </p>
    );
  if (q.isPending) return <Spinner label="Building from your data…" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const ask = ASK[kind];
  return (
    <div>
      {compact ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted" data-dynamic>
            Built from Jarvis data {new Date(q.data.builtAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}. Nothing
            changes until you apply.
          </p>
          <Button size="sm" variant="ghost" busy={rebuild.isPending} onClick={() => rebuild.mutate()}>
            Rebuild
          </Button>
          {ask ? (
            <ButtonLink size="sm" variant="ghost" href={chatHref({ label: ask.label, context: ask.context, draft: ask.draft })}>
              {ask.label}
            </ButtonLink>
          ) : null}
        </div>
      )}
      <SmartSurface key={q.data.sessionId + q.data.builtAt} spec={q.data.spec} sessionId={q.data.sessionId} blockIndex={q.data.blockIndex} dropped={0} />
    </div>
  );
}
