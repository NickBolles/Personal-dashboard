"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui";
import { CaptureTriageChip } from "@/components/capture/CaptureTriageChip";
import type { CaptureTriageView } from "@/lib/capture-triage";
import { api } from "@/lib/client/api";

export function CaptureTriageCard({ itemId }: { itemId: string }) {
  const qc = useQueryClient();
  const queryKey = ["capture-triage", itemId];
  const q = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<{ triage: CaptureTriageView | null }>(`/api/capture/triage?item=${encodeURIComponent(itemId)}`, signal),
  });
  const triage = q.data?.triage;
  if (q.isPending || !triage) return null;
  return (
    <div role="status" data-testid="capture-triage-card" className="mt-2 min-w-0">
      <Card className="min-w-0">
        <h3 className="mb-1 text-xs font-semibold">From your capture</h3>
        <CaptureTriageChip
          triage={triage}
          hideOpen
          onChanged={() => {
            void qc.invalidateQueries({ queryKey });
            void qc.invalidateQueries({ queryKey: ["work"] });
          }}
        />
        {triage.state === "done" ? (
          <p className="mt-1 text-xs text-muted">Check it and settle when you&apos;re happy — Jarvis never settles on its own.</p>
        ) : null}
      </Card>
    </div>
  );
}
