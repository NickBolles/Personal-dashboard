"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useToast } from "@/components/ui";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { WORKFLOW_START_EVENT } from "./events";
import { StartFormDialog, type StartFormData } from "./StartForm";

type Started = { run: { id: string }; input: string; context: string; areaId: string | null };
type StartDetail = { command?: string; workflowId?: string; shared?: string; triggeredBy?: "palette" | "share" | "schedule" };
const SLUG = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Reminder notifications deep-link to `?start=<slug>` (D6): open the start
 * form, never start a run. Watches the search params so a client-side
 * navigation (Alerts → router.push) opens it too, not only a full load (#144).
 */
function StartParamWatcher({ onStart }: { onStart: (d: StartDetail) => void }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const slug = params.get("start");
  useEffect(() => {
    if (!slug) return;
    const next = new URLSearchParams(params.toString());
    next.delete("start");
    const q = next.toString();
    router.replace(`${pathname}${q ? `?${q}` : ""}`, { scroll: false });
    if (SLUG.test(slug)) onStart({ command: `/${slug}`, triggeredBy: "schedule" });
  }, [slug, params, pathname, router, onStart]);
  return null;
}

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
  const open = useCallback(
    ({ command, workflowId, shared, triggeredBy }: StartDetail) => {
      setOrigin({ triggeredBy: triggeredBy ?? "palette", shared: shared?.slice(0, 2000) });
      api
        .post<StartFormData>("/api/workflows/form", command ? { command } : { workflowId })
        .then(setData)
        .catch((err: Error) => toast(err.message, "danger"));
    },
    [toast],
  );
  useEffect(() => {
    const on = (e: Event) => open((e as CustomEvent<StartDetail>).detail ?? {});
    window.addEventListener(WORKFLOW_START_EVENT, on);
    return () => window.removeEventListener(WORKFLOW_START_EVENT, on);
  }, [open]);
  const watcher = (
    <Suspense fallback={null}>
      <StartParamWatcher onStart={open} />
    </Suspense>
  );
  if (!data) return watcher;
  return (
    <>
      {watcher}
      <StartFormDialog
        data={data}
        onClose={() => setData(null)}
        onSubmit={async (values) => {
          const missing = (data.spec?.children ?? []).filter((el) => el.props.required && empty(values[el.props.id as string]));
          if (missing.length)
            return { errors: missing.map((el) => ({ field: el.props.id as string, message: `Add ${String(el.props.label).toLowerCase()}` })) };
          try {
            const s = await api.post<Started>("/api/workflows/runs", { workflowId: data.workflow.id, values, triggeredBy: origin.triggeredBy });
            setData(null);
            // palette words no field took stay in the first message instead of being dropped (#124)
            const first = [s.input, data.unmatched?.trim(), origin.shared].filter(Boolean).join("\n\n");
            const ok = await asker.ask(first, {
              areaId: s.areaId,
              context: s.context,
              onSession: async (id) => {
                const link = () => api.patch(`/api/workflows/runs/${encodeURIComponent(s.run.id)}`, { conversationId: id });
                try {
                  qc.setQueryData(["workflow-run", id], await link());
                } catch {
                  // one retry, then say so: an unlinked chat shows no Run panel (#135)
                  try {
                    qc.setQueryData(["workflow-run", id], await link());
                  } catch {
                    toast("Couldn't link this chat to the workflow run. Open it from Workflows → History.", "danger");
                  }
                }
              },
            });
            if (!ok) router.push(`/workflows?run=${encodeURIComponent(s.run.id)}`);
          } catch (err) {
            toast((err as Error).message, "danger");
          }
        }}
      />
    </>
  );
}
