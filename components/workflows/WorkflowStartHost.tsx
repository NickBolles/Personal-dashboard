"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
  const { toast } = useToast();
  const asker = useAskHermes();
  const router = useRouter();
  useEffect(() => {
    const on = (e: Event) => {
      const { command, workflowId } = (e as CustomEvent<{ command?: string; workflowId?: string }>).detail ?? {};
      api
        .post<StartFormData>("/api/workflows/form", command ? { command } : { workflowId })
        .then(setData)
        .catch((err: Error) => toast(err.message, "danger"));
    };
    window.addEventListener(WORKFLOW_START_EVENT, on);
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
          const s = await api.post<Started>("/api/workflows/runs", { workflowId: data.workflow.id, values, triggeredBy: "palette" });
          setData(null);
          const ok = await asker.ask(s.input, {
            areaId: s.areaId,
            context: s.context,
            onSession: (id) => api.patch(`/api/workflows/runs/${encodeURIComponent(s.run.id)}`, { conversationId: id }),
          });
          if (!ok) router.push(`/workflows?run=${encodeURIComponent(s.run.id)}`);
        } catch (err) {
          toast((err as Error).message, "danger");
        }
      }}
    />
  );
}
