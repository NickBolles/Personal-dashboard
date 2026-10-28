"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { api, ApiError } from "@/lib/client/api";
import type { JarvisSpec } from "@/lib/jarvis-ui/catalog";
import { describeIntent, intentTarget, type Intent } from "@/lib/jarvis-ui/intents";
import { canonicalJson, specRefs } from "@/lib/jarvis-ui/validator";
import type { AppliedEntry, ApplyResult, HydrateResponse, SurfaceView } from "@/lib/jarvis-ui/types";
import { Button, cx, useToast } from "@/components/ui";
import { SurfaceContext, type SurfaceCtx } from "./context";
import { registry } from "./registry";

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * One validated jarvis-ui block. Stores the spec on first render (the server
 * re-validates it), hydrates refs from live Jarvis data, and keeps a change
 * tray: taps stage intents; nothing is written until "Apply N changes".
 */
export function SmartSurface({ spec, sessionId, blockIndex, dropped }: { spec: JarvisSpec; sessionId: string; blockIndex: number; dropped: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const canon = useMemo(() => canonicalJson(spec), [spec]);
  const refs = useMemo(() => specRefs(spec), [spec]);
  const surfaceKey = ["smart-surface", sessionId, blockIndex, canon];
  const surface = useQuery({
    queryKey: surfaceKey,
    queryFn: () => api.put<SurfaceView>("/api/smart/surfaces", { sessionId, blockIndex, spec }),
    staleTime: Infinity,
    retry: 1,
  });
  const hydrate = useQuery({
    queryKey: ["smart-hydrate", refs],
    queryFn: () =>
      refs.length ? api.post<HydrateResponse>("/api/smart/hydrate", { refs }) : Promise.resolve({ refs: {}, today: localToday() } as HydrateResponse),
    staleTime: 30_000,
  });
  const [staged, setStaged] = useState<Map<string, Intent>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [review, setReview] = useState(false);
  const [undoing, setUndoing] = useState<string>();
  const version = useRef(0);
  const view = surface.data;

  const applied = useMemo(() => {
    const m = new Map<string, AppliedEntry>();
    for (const e of view?.applied ?? []) if (e.ok && !e.undone) m.set(intentTarget(e.intent as Intent), e);
    return m;
  }, [view]);
  const checks = Array.isArray(view?.state.checks) ? (view!.state.checks as string[]) : [];

  const setView = (v: SurfaceView) => qc.setQueryData(surfaceKey, v);
  const refreshData = () => qc.invalidateQueries({ queryKey: ["smart-hydrate"] });

  const apply = useMutation({
    mutationFn: async () => {
      const entries = [...staged.entries()];
      version.current += 1;
      const r = await api.post<{ results: ApplyResult[]; surface: SurfaceView }>("/api/smart/apply", {
        surfaceId: view!.id,
        intents: entries.map(([, i]) => i),
        idempotencyKey: `${view!.id}:${version.current}:${entries.length}`,
      });
      return { entries, ...r };
    },
    onSuccess: ({ entries, results, surface: next }) => {
      setView(next);
      const keep = new Map<string, Intent>();
      const errs = new Map<string, string>();
      results.forEach((r, i) => {
        const [k, intent] = entries[i]!;
        if (!r.ok) {
          keep.set(k, intent);
          errs.set(k, r.message);
        }
      });
      setStaged(keep);
      setErrors(errs);
      setReview(false);
      const ok = results.filter((r) => r.ok).length;
      toast(errs.size ? `${ok} applied, ${errs.size} failed (still staged)` : `${ok} ${ok === 1 ? "change" : "changes"} applied`, errs.size ? "warn" : "ok");
      refreshData();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't apply those changes", "danger"),
  });

  const ctx: SurfaceCtx = {
    surfaceId: view?.id,
    today: hydrate.data?.today ?? localToday(),
    readOnly: !view || view.readOnly,
    refs: hydrate.data?.refs ?? {},
    hydrating: hydrate.isPending,
    staged,
    errors,
    applied,
    undoing,
    checks,
    stage: (target, intent) => {
      setStaged((prev) => {
        const next = new Map(prev);
        if (intent) next.set(target, intent);
        else next.delete(target);
        return next;
      });
      setErrors((prev) => {
        if (!prev.has(target)) return prev;
        const next = new Map(prev);
        next.delete(target);
        return next;
      });
    },
    undo: async (entry) => {
      if (!view) return;
      setUndoing(entry.intentHash);
      try {
        const r = await api.post<{ surface: SurfaceView }>("/api/smart/undo", { surfaceId: view.id, intentHash: entry.intentHash });
        setView(r.surface);
        toast("Undone", "ok");
        refreshData();
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "Couldn't undo that", "danger");
      } finally {
        setUndoing(undefined);
      }
    },
    toggleCheck: async (id) => {
      if (!view) return;
      const next = checks.includes(id) ? checks.filter((c) => c !== id) : [...checks, id];
      setView({ ...view, state: { ...view.state, checks: next } });
      try {
        setView(await api.patch<SurfaceView>(`/api/smart/surfaces/${encodeURIComponent(view.id)}/state`, { state: { ...view.state, checks: next } }));
      } catch {
        toast("Couldn't save that tick", "danger");
      }
    },
  };

  const titleOf = (ref: string) => {
    const h = ctx.refs[ref];
    return h && "title" in h ? h.title : undefined;
  };
  const n = staged.size;

  if (surface.isError) {
    return <p className="text-xs text-muted">Interactive part unavailable: {surface.error instanceof ApiError ? surface.error.message : "try again later"}.</p>;
  }

  return (
    <SurfaceContext.Provider value={ctx}>
      <div className="smart-surface my-2 overflow-hidden rounded-[12px] border border-line bg-surface" data-testid="smart-surface">
        <div className="space-y-3 p-2.5">
          <JSONUIProvider registry={registry}>
            <Renderer spec={spec as unknown as Spec} registry={registry} />
          </JSONUIProvider>
          {dropped ? <p className="text-xs text-muted">Some content couldn’t be shown.</p> : null}
        </div>
        {ctx.readOnly ? null : (
          <div className="sticky bottom-0 border-t border-line-strong bg-surface">
            {review && n ? (
              <ul className="max-h-60 overflow-y-auto border-b border-line px-3 py-1.5 text-sm" aria-label="Staged changes">
                {[...staged.entries()].map(([k, i]) => (
                  <li key={k} className="flex items-center gap-2 py-1">
                    <span className="min-w-0 flex-1">{describeIntent(i, titleOf)}</span>
                    <Button size="sm" variant="ghost" onClick={() => ctx.stage(k, undefined)} aria-label={`Remove: ${describeIntent(i, titleOf)}`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2 px-3 py-2" aria-live="polite">
              <p className={cx("min-w-0 flex-1 text-sm", n ? "font-semibold" : "text-muted")} data-testid="smart-tray-count">
                {n ? `${n} ${n === 1 ? "change" : "changes"} staged` : "Nothing changes until you apply"}
              </p>
              {n ? (
                <>
                  <Button size="sm" variant="ghost" aria-expanded={review} onClick={() => setReview((r) => !r)}>
                    {review ? "Hide" : "Review"}
                  </Button>
                  <Button size="sm" variant="primary" busy={apply.isPending} onClick={() => apply.mutate()}>
                    Apply {n} {n === 1 ? "change" : "changes"}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </SurfaceContext.Provider>
  );
}
