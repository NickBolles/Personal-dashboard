"use client";

import { Button, ButtonLink, Pill, type KTone } from "@/components/ui";
import { useWorkMutation } from "@/components/work/common";
import { TRIAGE_CHIP, type CaptureTriageState, type CaptureTriageView } from "@/lib/capture-triage";
import { api } from "@/lib/client/api";

const TONE: Record<CaptureTriageState, KTone> = {
  planned: "ai",
  applying: "ai",
  done: "ai",
  needs_input: "wn",
  suggested: "prop",
  filed: "neutral",
  failed: "bad",
  undone: "neutral",
  skipped: "neutral",
};

export function CaptureTriageChip({ triage, onChanged, hideOpen }: { triage: CaptureTriageView; onChanged?: () => void; hideOpen?: boolean }) {
  const undo = useWorkMutation(() => api.post<{ triage: CaptureTriageView }>(`/api/capture/triage/${encodeURIComponent(triage.id)}/undo`, {}), {
    ok: "Undone",
    onSuccess: () => onChanged?.(),
  });
  const retry = useWorkMutation(() => api.post<{ triage: CaptureTriageView }>(`/api/capture/triage/${encodeURIComponent(triage.id)}/retry`, {}), {
    ok: "Retrying triage",
    onSuccess: () => onChanged?.(),
  });
  const apply = useWorkMutation(() => api.post<{ triage: CaptureTriageView }>(`/api/capture/triage/${encodeURIComponent(triage.id)}/apply`, {}), {
    ok: "On it",
    onSuccess: () => onChanged?.(),
  });
  const busy = undo.isPending || retry.isPending || apply.isPending;
  const triaging = triage.state === "planned" || triage.state === "applying";
  const canOpen = !hideOpen && triage.itemId && (triage.state === "done" || triage.state === "needs_input" || triage.state === "filed");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" data-testid="capture-triage" data-state={triage.state}>
      <Pill tone={TONE[triage.state]}>{triaging ? <span className="ai-shimmer">{TRIAGE_CHIP[triage.state]}</span> : TRIAGE_CHIP[triage.state]}</Pill>
      {triage.state === "needs_input" && triage.decisionRef ? (
        <ButtonLink size="sm" variant="ghost" href={`/decisions/${encodeURIComponent(triage.decisionRef)}`}>
          {triage.decisionRef}
        </ButtonLink>
      ) : null}
      <span className="min-w-0 text-xs break-words text-muted wrap-anywhere">{triage.summary}</span>
      {triage.state === "failed" ? (
        <Button size="sm" variant="ghost" loading={retry.isPending} disabled={busy} onClick={() => retry.mutate(undefined)}>
          Retry
        </Button>
      ) : null}
      {triage.canApply ? (
        <Button
          size="sm"
          variant="ghost"
          loading={apply.isPending}
          disabled={busy}
          onClick={() => apply.mutate(undefined)}
          aria-label={`Do it: ${triage.summary}`}
        >
          Do it
        </Button>
      ) : null}
      {triage.undoable ? (
        <Button
          size="sm"
          variant="ghost"
          loading={undo.isPending}
          disabled={busy}
          onClick={() => undo.mutate(undefined)}
          aria-label={`Undo: ${triage.summary}`}
        >
          Undo
        </Button>
      ) : null}
      {triage.openHref ? (
        <ButtonLink size="sm" variant="ghost" href={triage.openHref} className="max-w-full whitespace-normal wrap-anywhere">
          {triage.openLabel ?? "Correct"}
        </ButtonLink>
      ) : null}
      {canOpen ? (
        <ButtonLink size="sm" variant="ghost" href={`/areas?item=${encodeURIComponent(triage.itemId!)}`}>
          Open
        </ButtonLink>
      ) : null}
    </div>
  );
}
