"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { LIMITS, type JarvisSpec } from "@/lib/jarvis-ui/catalog";
import { describeIntent, intentKey, intentTarget, isExternal, type Intent } from "@/lib/jarvis-ui/intents";
import { canonicalJson, specRefs } from "@/lib/jarvis-ui/validator";
import type { AppliedEntry, ApplyResult, HydrateResponse, SurfaceView } from "@/lib/jarvis-ui/types";
import { Button, Dialog, cx, useToast } from "@/components/ui";
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
/** Components that can stage a change; surfaces without one (a PR card) show no tray. */
const STAGING = new Set(["TaskList", "DecisionCard", "ApprovalChips", "WeekPlan"]);

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
  const [approveCal, setApproveCal] = useState(false);
  const [undoing, setUndoing] = useState<string>();
  const batch = useRef<{ sig: string; key: string }>(undefined);
  const checkSeq = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const view = surface.data;

  const applied = useMemo(() => {
    const m = new Map<string, AppliedEntry>();
    for (const e of view?.applied ?? []) if (e.ok && !e.undone && !e.noop) m.set(intentTarget(e.intent as Intent), e);
    return m;
  }, [view]);
  const checks = Array.isArray(view?.state.checks) ? (view!.state.checks as string[]) : [];
  const skips = Array.isArray(view?.state.skips) ? (view!.state.skips as string[]) : [];

  const setView = (v: SurfaceView) => qc.setQueryData(surfaceKey, v);
  // Apply/undo responses carry the applied history; keep the newest local UI state (checklist ticks).
  const setApplied = (v: SurfaceView) => qc.setQueryData<SurfaceView>(surfaceKey, (prev) => (prev ? { ...v, state: prev.state } : v));
  const refreshData = () => qc.invalidateQueries({ queryKey: ["smart-hydrate"] });

  const apply = useMutation({
    mutationFn: async (external: boolean) => {
      // Calendar blocks never ride along with an ordinary Apply: they go out only from their own approval.
      const entries = [...staged.entries()].filter(([, i]) => isExternal(i) === external);
      // One idempotency key per staged batch (unique across reloads and devices);
      // a retry of the very same batch reuses it so the server can replay.
      const sig = canonicalJson(entries);
      if (batch.current?.sig !== sig) batch.current = { sig, key: newIdempotencyKey("smart") };
      const results: ApplyResult[] = [];
      let next: SurfaceView | undefined;
      // The endpoint takes ≤ 50 intents per call; larger trays go in chunks.
      for (let i = 0; i < entries.length; i += LIMITS.applyIntents) {
        const chunk = entries.slice(i, i + LIMITS.applyIntents);
        const r = await api.post<{ results: ApplyResult[]; surface: SurfaceView }>("/api/smart/apply", {
          surfaceId: view!.id,
          intents: chunk.map(([, intent]) => intent),
          idempotencyKey: `${batch.current.key}:${i / LIMITS.applyIntents}`,
          ...(external ? { external: true } : {}),
        });
        results.push(...r.results);
        next = r.surface;
      }
      batch.current = undefined;
      return { entries, results, surface: next! };
    },
    onSuccess: ({ entries, results, surface: next }) => {
      setApplied(next);
      // Reconcile against the current tray: drop only what was submitted and
      // applied unchanged; failures stay staged with their error.
      const errs = new Map<string, string>();
      const done = new Map<string, string>();
      results.forEach((r, i) => {
        const [k, intent] = entries[i]!;
        if (r.ok) done.set(k, intentKey(intent));
        else errs.set(k, r.message);
      });
      setStaged((prev) => {
        const keep = new Map(prev);
        for (const [k, key] of done) if (keep.get(k) && intentKey(keep.get(k)!) === key) keep.delete(k);
        return keep;
      });
      setErrors((prev) => {
        const next = new Map(prev);
        for (const [k] of entries) next.delete(k);
        for (const [k, v] of errs) next.set(k, v);
        return next;
      });
      setReview(false);
      setApproveCal(false);
      const ok = results.filter((r) => r.ok).length;
      toast(errs.size ? `${ok} applied, ${errs.size} failed (still staged)` : `${ok} ${ok === 1 ? "change" : "changes"} applied`, errs.size ? "warn" : "ok");
      refreshData();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Couldn't apply those changes", "danger"),
  });

  const readOnly = !view || view.readOnly;
  const ctx: SurfaceCtx = {
    surfaceId: view?.id,
    today: hydrate.data?.today ?? localToday(),
    readOnly,
    refs: hydrate.data?.refs ?? {},
    hydrating: hydrate.isPending,
    staged,
    errors,
    applied,
    undoing,
    checks,
    stage: (target, intent) => {
      if (apply.isPending) return;
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
      if (!view || view.readOnly) return;
      setUndoing(entry.intentHash);
      try {
        const r = await api.post<{ surface: SurfaceView }>("/api/smart/undo", { surfaceId: view.id, intentHash: entry.intentHash });
        setApplied(r.surface);
        toast("Undone", "ok");
        refreshData();
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "Couldn't undo that", "danger");
      } finally {
        setUndoing(undefined);
      }
    },
    toggleCheck: (id) => patchState({ checks: checks.includes(id) ? checks.filter((c) => c !== id) : [...checks, id] }, "Couldn't save that tick"),
    skips,
    toggleSkip: (ref) => patchState({ skips: skips.includes(ref) ? skips.filter((c) => c !== ref) : [...skips, ref] }, "Couldn't save that"),
    uiState: view?.state ?? {},
    patchState: (patch) => patchState(patch, "Couldn't save the plan"),
  };

  /** Surface UI state (ticks, skips, block positions): never a write to your data, saved one at a time, newest wins. */
  function patchState(patch: Record<string, unknown>, failMsg: string) {
    if (!view || view.readOnly) return;
    const cur = qc.getQueryData<SurfaceView>(surfaceKey) ?? view;
    setView({ ...cur, state: { ...cur.state, ...patch } });
    // Saves run one at a time and only the newest edit is sent, so a slow or
    // out-of-order response can never drop a newer change.
    const mine = ++checkSeq.current;
    saveChain.current = saveChain.current.then(async () => {
      if (mine !== checkSeq.current) return;
      const latest = qc.getQueryData<SurfaceView>(surfaceKey);
      if (!latest) return;
      try {
        const saved = await api.patch<SurfaceView>(`/api/smart/surfaces/${encodeURIComponent(latest.id)}/state`, { state: latest.state });
        if (mine === checkSeq.current) qc.setQueryData<SurfaceView>(surfaceKey, (prev) => (prev ? { ...prev, state: saved.state } : saved));
      } catch {
        toast(failMsg, "danger");
      }
    });
  }

  const titleOf = (ref: string) => {
    const h = ctx.refs[ref];
    return h && "title" in h ? h.title : undefined;
  };
  const stagedList = [...staged.entries()];
  const regular = stagedList.filter(([, i]) => !isExternal(i));
  const external = stagedList.filter(([, i]) => isExternal(i));
  const n = regular.length;
  const stageable = Object.values(spec.elements).some((e) => STAGING.has(e.type));

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
        {readOnly || !stageable ? null : (
          <div className="sticky bottom-0 border-t border-line-strong bg-surface">
            {review && n ? (
              <ul className="max-h-60 overflow-y-auto border-b border-line px-3 py-1.5 text-sm" aria-label="Staged changes">
                {regular.map(([k, i]) => (
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
                  <Button size="sm" variant="primary" busy={apply.isPending && !approveCal} onClick={() => apply.mutate(false)}>
                    Apply {n} {n === 1 ? "change" : "changes"}
                  </Button>
                </>
              ) : null}
            </div>
            {external.length ? (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2">
                <p className="min-w-0 flex-1 text-sm" data-testid="smart-calendar-count">
                  {external.length} calendar {external.length === 1 ? "block" : "blocks"} staged · needs its own approval
                </p>
                <Button size="sm" onClick={() => setApproveCal(true)}>
                  Review calendar…
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {approveCal && external.length ? (
        <Dialog
          open
          onClose={() => setApproveCal(false)}
          title={`Add ${external.length} ${external.length === 1 ? "block" : "blocks"} to the calendar?`}
          description="These are written to the household calendar in Home Assistant and read back. Jarvis can't remove them later; delete them in the calendar if you change your mind."
          footer={
            <>
              <Button onClick={() => setApproveCal(false)}>Cancel</Button>
              <Button variant="primary" busy={apply.isPending} onClick={() => apply.mutate(true)}>
                Add to calendar
              </Button>
            </>
          }
        >
          <ul className="space-y-1 text-sm" aria-label="Calendar blocks to add">
            {external.map(([k, i]) => (
              <li key={k} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">{describeIntent(i, titleOf)}</span>
                <Button size="sm" variant="ghost" onClick={() => ctx.stage(k, undefined)} aria-label={`Remove: ${describeIntent(i, titleOf)}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </SurfaceContext.Provider>
  );
}
