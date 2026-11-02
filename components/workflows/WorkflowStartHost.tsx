"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useToast } from "@/components/ui";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { WORKFLOW_START_EVENT } from "./events";
import { StartFormDialog, type StartFormData } from "./StartForm";

type Started = { run: { id: string }; input: string; context: string; areaId: string | null };

function empty(v: unknown) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/**
 * Palette `/slug args` → start form (D7: always shown, prefilled, one tap
 * Start) → live run → filed chat whose first turn carries the run context.
 * Mounted once in AppShell so the form outlives the palette.
 */
export function WorkflowStartHost() {
  const [data, setData] = useState<StartFormData | null>(null);
  // where the start came from (palette / share / schedule) and shared text that becomes the first note
  const [origin, setOrigin] = useState<{ triggeredBy: "palette" | "share" | "schedule"; shared?: string }>({ triggeredBy: "palette" });
  const { toast } = useToast();
  const asker = useAskHermes();
  const router = useRouter();
  const qc = useQueryClient();
  useEffect(() => {
    const on = (e: Event) => {
      const { command, workflowId, shared, triggeredBy } =
        (e as CustomEvent<{ command?: string; workflowId?: string; shared?: string; triggeredBy?: "palette" | "share" | "schedule" }>).detail ?? {};
      setOrigin({ triggeredBy: triggeredBy ?? "palette", shared: shared?.slice(0, 2000) });
      api
        .post<StartFormData>("/api/workflows/form", command ? { command } : { workflowId })
        .then(setData)
        .catch((err: Error) => toast(err.message, "danger"));
    };
    window.addEventListener(WORKFLOW_START_EVENT, on);
    // Reminder notifications deep-link to ?start=<slug> (D6): open the start form, never start a run.
    const url = new URL(window.location.href);
    const slug = url.searchParams.get("start");
    if (slug && /^[a-z][a-z0-9-]{1,39}$/.test(slug)) {
      url.searchParams.delete("start");
      window.history.replaceState(window.history.state, "", url.toString());
      window.dispatchEvent(new CustomEvent(WORKFLOW_START_EVENT, { detail: { command: `/${slug}`, triggeredBy: "schedule" } }));
    }
    return () => window.removeEventListener(WORKFLOW_START_EVENT, on);
  }, [toast]);
  if (!data) return null;
  return (
    <StartFormDialog
      data={data}
      onClose={() => setData(null)}
      onSubmit={async (values) => {
        const missing = (data.spec?.children ?? []).filter((el) => el.props.required && empty(values[el.props.id as string]));
        if (missing.length) return { errors: missing.map((el) => ({ field: el.props.id as string, message: `Add ${String(el.props.label).toLowerCase()}` })) };
        try {
          const s = await api.post<Started>("/api/workflows/runs", { workflowId: data.workflow.id, values, triggeredBy: origin.triggeredBy });
          setData(null);
          const ok = await asker.ask(origin.shared ? `${s.input}\n\n${origin.shared}` : s.input, {
            areaId: s.areaId,
            context: s.context,
            onSession: async (id) =>
              qc.setQueryData(["workflow-run", id], await api.patch(`/api/workflows/runs/${encodeURIComponent(s.run.id)}`, { conversationId: id })),
          });
          if (!ok) router.push(`/workflows?run=${encodeURIComponent(s.run.id)}`);
        } catch (err) {
          toast((err as Error).message, "danger");
        }
      }}
    />
  );
}
