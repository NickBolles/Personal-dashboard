"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/legacy";
import { WORKFLOW_START_EVENT } from "./events";

type Wf = { id: string; slug: string; name: string; status: string };

/**
 * Share target → "Start workflow…" (W4 triggers): pick an active workflow;
 * the shared text prefills its start form (scripture/place/date tokens) and
 * becomes the first note. Shared URLs stay text and are never fetched.
 */
export function ShareWorkflowPicker({ text, onStarted }: { text: string; onStarted?: () => void }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["workflows"],
    queryFn: ({ signal }) => api.get<{ workflows: Wf[] }>("/api/workflows", signal),
    enabled: open,
  });
  const active = (q.data?.workflows ?? []).filter((w) => w.status === "active");
  if (!text.trim()) return null;
  if (!open)
    return (
      <Button type="button" onClick={() => setOpen(true)} data-testid="share-start-workflow">
        Start workflow…
      </Button>
    );
  return (
    <div className="flex basis-full flex-col gap-1" role="group" aria-label="Start a workflow with this">
      {q.isLoading ? <p className="text-xs text-muted">Loading workflows…</p> : null}
      {!q.isLoading && !active.length ? <p className="text-xs text-muted">No workflows are on yet.</p> : null}
      <div className="flex flex-wrap gap-2">
        {active.map((w) => (
          <Button
            key={w.id}
            type="button"
            size="sm"
            onClick={() => {
              const firstLine = text.split("\n")[0].slice(0, 120);
              window.dispatchEvent(
                new CustomEvent(WORKFLOW_START_EVENT, { detail: { command: `/${w.slug} ${firstLine}`.trim(), shared: text, triggeredBy: "share" } }),
              );
              onStarted?.();
            }}
          >
            {w.name}
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
