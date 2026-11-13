"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { api, ApiError, newIdempotencyKey } from "@/lib/client/api";
import { LIMITS, type JarvisSpec } from "@/lib/jarvis-ui/catalog";
import { describeIntent, intentInSpec, intentKey, intentSchema, intentTarget, isExternal, type Intent } from "@/lib/jarvis-ui/intents";
import { smartLabel } from "@/lib/jarvis-ui/labels";
import { canonicalJson, specRefs } from "@/lib/jarvis-ui/validator";
import type { AppliedEntry, ApplyResult, HydrateResponse, SurfaceView } from "@/lib/jarvis-ui/types";
import { Dialog, cx, useToast } from "@/components/ui";
import { Button } from "@/components/ui/legacy";
import { SurfaceContext, type SurfaceCtx } from "./context";
import { registry } from "./registry";
import { isLatestSmartUndo, registerSmartUndo, smartUndoKey } from "@/lib/jarvis-ui/v2";
import "./smart.css";

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const STAGING = new Set(["TaskList", "DecisionCard", "ApprovalChips", "WeekPlan", "DecisionMatrix", "Gantt", "Form"]);

/** One canonical surface: ref hydration, durable drafts, confirmed Apply and recorded Undo. */
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
  const view = surface.data;
  const today = hydrate.data?.today ?? localToday();
  const [localStaged, setLocalStaged] = useState<Map<string, Intent>>();
  const savedStaged = useMemo(() => {
    const saved = new Map<string, Intent>();
    if (Array.isArray(view?.state.staged))
      for (const entry of view.state.staged) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const intent = intentSchema.safeParse(entry[1]);
        if (intent.success && intentInSpec(spec, intent.data, today)) saved.set(entry[0], intent.data);
      }
    return saved;
  }, [view, spec, today]);
  const staged = localStaged ?? savedStaged;
  const setStaged = (fn: (prev: Map<string, Intent>) => Map<string, Intent>) => setLocalStaged((prev) => fn(prev ?? savedStaged));
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [review, setReview] = useState(false);
  const [approveCal, setApproveCal] = useState(false);
  const [undoing, setUndoing] = useState<string>();
  const [undoWindow, setUndoWindow] = useState<{ token: string; hashes: string[] }>();
  const [confirmApply, setConfirmApply] = useState(false);
  const needsConfirm = Object.values(spec.elements).some((e) => ["Form", "DecisionMatrix", "Gantt"].includes(e.type));
  const batch = useRef<{ sig: string; key: string }>(undefined);
  const checkSeq = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const undoLock = useRef(false);
  const applied = useMemo(() => {
    const m = new Map<string, AppliedEntry>();
    for (const e of view?.applied ?? []) if (e.ok && !e.undone && !e.noop) m.set(intentTarget(e.intent as Intent), e);
    return m;
  }, [view]);
  const checks = Array.isArray(view?.state.checks) ? (view.state.checks as string[]) : [];
  const skips = Array.isArray(view?.state.skips) ? (view.state.skips as string[]) : [];
  const setApplied = (v: SurfaceView) => qc.setQueryData<SurfaceView>(surfaceKey, (prev) => (prev ? { ...v, state: prev.state } : v));
  const refreshData = () => {
    void qc.invalidateQueries({ queryKey: ["smart-hydrate"] });
  };

  /** Serialize UI state saves: a stale checklist/draft response cannot replace a newer edit. */
  function patchState(patch: Record<string, unknown>, failMsg: string) {
    if (!view || view.readOnly) return;
    const cur = qc.getQueryData<SurfaceView>(surfaceKey) ?? view;
    qc.setQueryData(surfaceKey, { ...cur, state: { ...cur.state, ...patch } });
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
  const apply = useMutation({
    mutationFn: async (external: boolean) => {
      // Calendar blocks never ride along with an ordinary Apply.
      const entries = [...staged.entries()].filter(([, i]) => isExternal(i) === external);
      const sig = canonicalJson(entries);
      if (batch.current?.sig !== sig) batch.current = { sig, key: newIdempotencyKey("smart") };
      const results: ApplyResult[] = [];
      let next: SurfaceView | undefined;
      for (let i = 0; i < entries.length; i += LIMITS.applyIntents) {
        const r = await api.post<{ results: ApplyResult[]; surface: SurfaceView }>("/api/smart/apply", {
          surfaceId: view!.id,
          intents: entries.slice(i, i + LIMITS.applyIntents).map(([, intent]) => intent),
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
      const token = newIdempotencyKey("undo");
      registerSmartUndo(token);
      setUndoWindow({ token, hashes: results.filter((r) => r.ok).map((r) => r.intentHash) });
      setConfirmApply(false);
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
  async function undo(entry: AppliedEntry) {
    if (!view || view.readOnly || undoLock.current) return;
    undoLock.current = true;
    setUndoing(entry.intentHash);
    try {
      const r = await api.post<{ surface: SurfaceView }>("/api/smart/undo", { surfaceId: view.id, intentHash: entry.intentHash });
      setApplied(r.surface);
      toast("Undone", "ok");
      refreshData();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't undo that", "danger");
    } finally {
      undoLock.current = false;
      setUndoing(undefined);
    }
  }
  const readOnly = !view || view.readOnly;
  const ctx: SurfaceCtx = {
    surfaceId: view?.id,
    today,
    readOnly,
    refs: hydrate.data?.refs ?? {},
    hydrating: hydrate.isPending,
    staged,
    errors,
    applied,
    undoing,
    checks,
    stage: (target, intent) => {
      if (apply.isPending || readOnly) return;
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
    undo,
    toggleCheck: (id) => patchState({ checks: checks.includes(id) ? checks.filter((c) => c !== id) : [...checks, id] }, "Couldn't save that tick"),
    skips,
    toggleSkip: (ref) => patchState({ skips: skips.includes(ref) ? skips.filter((c) => c !== ref) : [...skips, ref] }, "Couldn't save that"),
    uiState: view?.state ?? {},
    patchState: (patch) => patchState(patch, "Couldn't save the plan"),
  };
  const persistDraft = useEffectEvent(() => {
    const entries = [...staged.entries()];
    if (view && !view.readOnly && canonicalJson(view.state.staged ?? []) !== canonicalJson(entries))
      patchState({ pending: entries.length, staged: entries }, "Couldn't save staged draft");
  });
  useEffect(() => {
    persistDraft();
  }, [staged, view?.id]);
  useEffect(() => {
    if (!undoWindow) return;
    const timer = window.setTimeout(() => setUndoWindow(undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [undoWindow]);
  const undoEntries = [...applied.values()].filter((e) => e.undo && e.undo.type !== "none" && undoWindow?.hashes.includes(e.intentHash)).reverse();
  const undoRecent = async () => {
    for (const e of undoEntries) await undo(e);
  };
  useEffect(() => {
    if (!undoWindow || !undoEntries.length || undoing) return;
    const listener = (e: KeyboardEvent) => {
      if (isLatestSmartUndo(undoWindow.token) && smartUndoKey(e)) {
        e.preventDefault();
        void undoRecent();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  const titleOf = (ref: string) => {
    const h = ctx.refs[ref];
    return h && "title" in h ? h.title : undefined;
  };
  const regular = [...staged.entries()].filter(([, i]) => !isExternal(i));
  const external = [...staged.entries()].filter(([, i]) => isExternal(i));
  const n = regular.length;
  const stageable = Object.values(spec.elements).some((e) => STAGING.has(e.type));
  if (surface.isError)
    return <p className="text-xs text-muted">Interactive part unavailable: {surface.error instanceof ApiError ? surface.error.message : "try again later"}.</p>;
  return (
    <SurfaceContext.Provider value={ctx}>
      <div className="smart-surface my-2" data-testid="smart-surface">
        <div className="svh border-b border-line">
          {/* The root's human label; never the component's internal name. */}
          <span className="sv-tag">{smartLabel(spec.elements[spec.root]?.type) ?? "Jarvis"}</span>
          <span className="sv-label">{stageable ? "Proposed changes" : "Jarvis view"}</span>
          <span className="sv-meta">
            Proposed by <span className="text-ai">@jarvis</span>
          </span>
        </div>
        <div className="space-y-3 p-2.5" data-smart-body>
          <JSONUIProvider registry={registry}>
            <Renderer spec={spec as unknown as Spec} registry={registry} />
          </JSONUIProvider>
          {dropped ? <p className="text-xs text-muted">Some content couldn’t be shown.</p> : null}
        </div>
        {readOnly || !stageable ? null : (
          <div className="smart-tray sticky bottom-0">
            {review && n ? (
              <ul className="max-h-60 overflow-y-auto border-b border-line px-3 py-1.5 text-sm" aria-label="Staged changes">
                {regular.map(([k, i]) => (
                  <li key={k} className="flex flex-wrap items-center gap-2 py-1">
                    <span className="min-w-0 flex-1">{describeIntent(i, titleOf)}</span>
                    <Button size="sm" variant="ghost" onClick={() => ctx.stage(k, undefined)} aria-label={`Remove: ${describeIntent(i, titleOf)}`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5" aria-live="polite">
              {n ? (
                <span className="smart-tray-n" aria-hidden="true">
                  {n}
                </span>
              ) : null}
              <p
                className={cx("min-w-0 flex-1 basis-32 text-sm", n ? "font-semibold" : applied.size ? "text-ok" : "text-muted")}
                data-testid="smart-tray-count"
              >
                {n
                  ? `${n} ${n === 1 ? "change" : "changes"} staged`
                  : applied.size
                    ? `✓ ${applied.size} applied`
                    : "Nothing staged · nothing changes until you apply"}
              </p>
              {n ? (
                <span className="min-w-0 text-xs text-muted">
                  · {describeIntent(regular[0]![1], titleOf)}
                  {n > 1 ? ` +${n - 1}` : ""}
                </span>
              ) : null}

              {undoWindow && undoEntries.length ? (
                <Button size="sm" variant="ghost" aria-label="Undo latest smart change" busy={Boolean(undoing)} onClick={() => void undoRecent()}>
                  Undo
                </Button>
              ) : null}
              {n ? (
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" aria-expanded={review} onClick={() => setReview(!review)}>
                    {review ? "Hide" : "Review"}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    busy={apply.isPending && !approveCal}
                    onClick={() => (needsConfirm ? setConfirmApply(true) : apply.mutate(false))}
                  >
                    Apply {n} {n === 1 ? "change" : "changes"}
                  </Button>
                </span>
              ) : null}
            </div>
            {external.length ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
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
      {confirmApply ? (
        <Dialog
          open
          onClose={() => setConfirmApply(false)}
          title={`Apply ${n} ${n === 1 ? "change" : "changes"}?`}
          description="These changes write to your Jarvis items. You can Undo after applying."
          footer={
            <>
              <Button onClick={() => setConfirmApply(false)}>Cancel</Button>
              <Button variant="primary" busy={apply.isPending} onClick={() => apply.mutate(false)}>
                Confirm apply
              </Button>
            </>
          }
        >
          <ul className="space-y-2 text-sm">
            {regular.map(([k, i]) => (
              <li key={k}>{describeIntent(i, titleOf)}</li>
            ))}
          </ul>
        </Dialog>
      ) : null}
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
              <li key={k} className="flex flex-wrap items-center gap-2">
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
