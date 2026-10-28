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
    mutationFn: (patch: Partial<Settings>) => api.put<Settings>("/api/smart/settings", patch),
    onSuccess: (s, patch) => {
      qc.setQueryData(["smart-settings"], s);
      if (patch.enabled !== undefined) toast(s.enabled ? "Smart replies on" : "Smart replies off", "ok");
      else toast(s.calendarWrites ? "Calendar blocks on" : "Calendar blocks off", "ok");
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
          onChange={(e) => save.mutate({ enabled: e.target.checked })}
          aria-describedby="smart-help"
        />
        <span>
          <span className="font-medium">Interactive replies from Hermes</span>
          <span id="smart-help" className="block text-sm text-muted">
            Triage lists, choices and checklists you can act on. Nothing changes until you tap Apply, every change can be undone, and Finance is never sent to
            AI. Also powers the Morning brief, Plan the week and PR review cards.
          </span>
        </span>
      </label>
      <label className="mt-1 flex min-h-11 cursor-pointer items-start gap-3 pl-7 sm:min-h-10">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={q.data.calendarWrites}
          disabled={save.isPending || !q.data.enabled}
          onChange={(e) => save.mutate({ calendarWrites: e.target.checked })}
          aria-describedby="smart-cal-help"
        />
        <span>
          <span className="font-medium">Let week plans add calendar blocks</span>
          <span id="smart-cal-help" className="block text-sm text-muted">
            Off by default. When on, Plan the week can add time blocks to the household calendar in Home Assistant, each batch only after its own approval, with
            readback.
          </span>
        </span>
      </label>
    </Card>
  );
}
