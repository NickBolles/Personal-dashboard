"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, cx, useToast } from "@/components/ui";
import type { RunElement } from "@/lib/workflows/run-catalog";
import { displayValue, type CaptureOp } from "@/lib/workflows/runs";
import type { TimelineItem } from "@/lib/hermes";
import { ActionChecklist, EditSessionDialog, EndSessionDialog, ExportBar, ReflectionPrompt, SummaryCard, type RunOutputsView } from "./RunOutputs";

export type RunPanelView = {
  id: string;
  title: string;
  status: string;
  capture: Record<string, unknown>;
  log: { id: string; by: string; source?: string; undone: boolean }[];
  proposals: CaptureOp[];
  context: string | null;
  panel: RunElement[];
  definition: {
    capture: Record<string, { type: string; of?: unknown }>;
    mid?: { id: string; bind: string; type: string; label: string }[];
    end?: { id: string; bind: string; type: string; label: string; help?: string; maxLength?: number }[];
    reflectionPrompts?: string;
  };
};
type PatchResult = { run: RunPanelView; applied: string[]; dropped: number; proposed: number };

const key = (sessionId: string) => ["workflow-run", sessionId];

const WIDE = "(min-width: 1024px)";
const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia?.(WIDE);
  m?.addEventListener("change", cb);
  return () => m?.removeEventListener("change", cb);
};
/** ≥1024 px (desktop, unfolded foldables): the Run panel becomes a side panel beside the chat. */
export function useWideRun() {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia?.(WIDE).matches ?? false,
    () => false,
  );
}

/** The conversation's live workflow run (null for ordinary chats). */
export function useWorkflowRun(sessionId: string) {
  const q = useQuery({
    queryKey: key(sessionId),
    queryFn: ({ signal }) =>
      api.get<{ run: RunPanelView | null }>(`/api/workflows/runs?conversationId=${encodeURIComponent(sessionId)}`, signal).then((r) => r.run),
    staleTime: 30_000,
  });
  return q.data ?? null;
}

/**
 * Read each finished assistant turn once: fenced `jarvis-capture` ops are
 * validated server-side and applied instantly with Undo (D2).
 */
export function useAgentCapture(sessionId: string, run: RunPanelView | null, timeline: TimelineItem[], onApplied: (r: PatchResult) => void) {
  const qc = useQueryClient();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!run || run.status !== "live") return;
    for (const t of timeline) {
      if (t.kind !== "assistant" || seen.current.has(t.id)) continue;
      seen.current.add(t.id);
      if (!t.text.includes("```jarvis-capture")) continue;
      void api
        .patch<PatchResult>(`/api/workflows/runs/${encodeURIComponent(run.id)}`, { by: "agent", text: t.text, messageId: t.id })
        .then((r) => {
          qc.setQueryData(key(sessionId), r.run);
          if (r.applied.length || r.dropped || r.proposed) onApplied(r);
        })
        .catch(() => undefined);
    }
  }, [run, timeline, qc, sessionId, onApplied]);
}

function firstField(of: unknown) {
  return of && typeof of === "object" ? Object.keys(of as object)[0] : null;
}

/** Quick-add (§2.4): file the sent text straight into the chosen list (by:user), no model needed. */
export async function quickAdd(run: RunPanelView, field: string, text: string) {
  const of = run.definition.capture[field]?.of;
  const f = firstField(of);
  const value = f ? { [f]: text.slice(0, 2000) } : text.slice(0, 4000);
  return api.patch<PatchResult>(`/api/workflows/runs/${encodeURIComponent(run.id)}`, {
    by: "user",
    ops: [{ op: "add", path: `/${field}/-`, value }],
    source: "quickAdd",
  });
}

/**
 * Run panel (catalog-rendered: RunHeader · QuickAddChips · Outline). Phone:
 * collapses to a strip above the composer while the keyboard is open
 * (`html[data-kb=open]`, lib/client/keyboard.ts). ≥1100 px: chat | outline split.
 */
export function RunPanel({
  sessionId,
  run,
  target,
  onTarget,
}: {
  sessionId: string;
  run: RunPanelView;
  target: string | null;
  onTarget: (f: string | null) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const set = (r: RunPanelView) => qc.setQueryData(key(sessionId), r);
  const live = run.status === "live";
  const lastUndoable = [...run.log].reverse().find((e) => !e.undone && e.source !== "form:start");
  const undo = async (entries: string[] = []) => {
    try {
      const r = await api.post<{ run: RunPanelView; undone: string[]; failed: string[] }>(`/api/workflows/runs/${encodeURIComponent(run.id)}/undo`, {
        entries,
      });
      set(r.run);
      toast(r.failed.length ? "Undo the newer change first" : "Undone", r.failed.length ? "warn" : "ok");
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  const remove = async (field: string, index: number) => {
    try {
      const r = await api.patch<PatchResult>(`/api/workflows/runs/${encodeURIComponent(run.id)}`, {
        by: "user",
        ops: [{ op: "remove", path: `/${field}/${index}` }],
        source: "outline",
      });
      set(r.run);
    } catch (e) {
      toast((e as Error).message, "danger");
    }
  };
  const proposals = async (accept: number[], clear = false) => {
    const r = await api.post<PatchResult>(`/api/workflows/runs/${encodeURIComponent(run.id)}/proposals`, { accept, clear });
    set(r.run);
  };
  const [dialog, setDialog] = useState<"edit" | "end" | null>(null);
  const out = run as RunOutputsView;
  const hasEndForm = !!out.definition.end?.length;
  const canEdit = !!out.definition.mid?.some((f) => !f.bind.endsWith("/-"));
  const end = async () => {
    if (hasEndForm) return setDialog("end");
    const r = await api.post<RunPanelView>(`/api/workflows/runs/${encodeURIComponent(run.id)}/end`);
    set({ ...run, ...r });
    toast("Session ended", "ok");
  };
  const header = run.panel.find((e) => e.type === "RunHeader");
  const chips = (run.panel.find((e) => e.type === "QuickAddChips")?.props.chips ?? []) as { label: string; field: string }[];
  const sections = (run.panel.find((e) => e.type === "Outline")?.props.sections ?? []) as { title: string; bind: string; empty?: string }[];
  const count = (b: string) => (Array.isArray(run.capture[b]) ? (run.capture[b] as unknown[]).length : 0);
  const recent = sections.flatMap((s) => ((run.capture[s.bind] as unknown[]) ?? []).map((v) => `${s.title}: ${displayValue(v)}`)).slice(-2);
  return (
    <section className="wf-run min-w-0 border-b border-line bg-surface px-3 py-2 sm:px-6" aria-label="Workflow run" data-testid="workflow-run">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {live ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden /> : null}
        <h2 className="min-w-0 flex-auto truncate text-sm font-semibold">{(header?.props.title as string) ?? run.title}</h2>
        <span className="sr-only">{live ? "Live" : "Ended"}</span>
        {lastUndoable && live ? (
          <Button size="sm" variant="ghost" onClick={() => void undo()} data-testid="workflow-undo">
            Undo
          </Button>
        ) : null}
        {live && canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => setDialog("edit")} data-testid="workflow-edit-session">
            Edit session
          </Button>
        ) : null}
        {live ? (
          <Button size="sm" variant="primary" onClick={() => void end()}>
            End session
          </Button>
        ) : (
          <span className="text-xs text-muted">Ended</span>
        )}
      </div>
      {/* strip: counts + last 2 entries (shown while the keyboard is open on phones) */}
      <p className="wf-run-strip truncate text-xs text-muted" data-dynamic>
        {sections.map((s) => `${s.title} ${count(s.bind)}`).join(" · ")}
        {recent.length ? ` — ${recent.join(" · ")}` : ""}
      </p>
      {run.proposals.length ? (
        <div className="wf-run-full mt-2 rounded-lg border border-dashed border-accent p-2 text-sm" role="group" aria-label="Suggested values">
          {run.proposals.map((p, i) => (
            <div key={i} className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-auto">
                {p.path.split("/").pop()}: <strong>{displayValue(p.value)}</strong>
              </span>
              <Button size="sm" onClick={() => void proposals([i])}>
                Accept
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void proposals([], true)}>
            Clear suggestions
          </Button>
        </div>
      ) : null}
      {live && chips.length ? (
        <div className="wf-chips mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Next note goes to">
          {chips.map((c) => (
            <button
              key={c.field}
              type="button"
              aria-pressed={target === c.field}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onTarget(target === c.field ? null : c.field)}
              className={cx(
                "tap min-h-11 rounded-full border px-3 text-sm sm:min-h-9",
                target === c.field ? "border-accent bg-accent/10 font-medium" : "border-line-strong",
              )}
            >
              {c.label}
            </button>
          ))}
          <ReflectionPrompt sessionId={sessionId} run={out} />
        </div>
      ) : null}
      {dialog === "edit" ? <EditSessionDialog sessionId={sessionId} run={out} onClose={() => setDialog(null)} /> : null}
      {dialog === "end" ? <EndSessionDialog sessionId={sessionId} run={out} onClose={() => setDialog(null)} /> : null}
      {!live ? (
        <div className="wf-run-full mt-2 grid grid-cols-1 gap-2" data-testid="workflow-outputs">
          <SummaryCard sessionId={sessionId} run={out} />
          <ActionChecklist sessionId={sessionId} run={out} />
          <ExportBar run={out} />
        </div>
      ) : null}
      <div className="wf-run-full mt-2 grid grid-cols-1 gap-2 text-sm" data-testid="workflow-outline">
        {sections.map((s) => {
          const rows = (run.capture[s.bind] as unknown[]) ?? [];
          return (
            <div key={s.bind} className="min-w-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                {s.title} <span className="font-normal">({rows.length})</span>
              </h3>
              {s.bind === "scripture" && rows.length ? <p className="text-xs text-muted">Reference only · passage text isn&apos;t downloaded</p> : null}
              {rows.length ? (
                <ul className="space-y-1">
                  {rows.map((v, i) => (
                    <li key={i} className="flex min-w-0 items-start gap-2">
                      {s.bind === "quotes" ? (
                        <figure className="min-w-0 flex-1">
                          <blockquote className="break-words">“{displayValue(v)}”</blockquote>
                          {(v as { who?: string }).who ? <figcaption className="text-xs text-muted">— {(v as { who?: string }).who}</figcaption> : null}
                        </figure>
                      ) : (
                        <span className="min-w-0 flex-1 break-words">{displayValue(v)}</span>
                      )}
                      {live ? (
                        <button
                          type="button"
                          className="tap shrink-0 text-xs text-muted"
                          aria-label={`Remove from ${s.title}`}
                          onClick={() => void remove(s.bind, i)}
                        >
                          ×
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">{s.empty ?? "Nothing yet"}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
