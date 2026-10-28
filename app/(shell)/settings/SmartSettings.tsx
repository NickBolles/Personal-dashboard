"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { SmartSettings as Settings } from "@/lib/jarvis-ui/types";
import { Card, useToast } from "@/components/ui";
import { useSmartSettings } from "@/components/smart/AssistantText";

/** Settings → Smart replies: interactive Hermes replies (jarvis-ui@1). Off by default; per person. */
export function SmartSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useSmartSettings();
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put<Settings>("/api/smart/settings", { enabled }),
    onSuccess: (s) => {
      qc.setQueryData(["smart-settings"], s);
      toast(s.enabled ? "Smart replies on" : "Smart replies off", "ok");
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  if (!q.data) return null;
  return (
    <Card>
      <h2 className="eyebrow">Smart replies</h2>
      <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 sm:min-h-10">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={q.data.enabled}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
          aria-describedby="smart-help"
        />
        <span>
          <span className="font-medium">Interactive replies from Hermes</span>
          <span id="smart-help" className="block text-sm text-muted">
            Triage lists, choices and checklists you can act on. Nothing changes until you tap Apply, every change can be undone, and Finance is never sent to
            AI.
          </span>
        </span>
      </label>
    </Card>
  );
}
