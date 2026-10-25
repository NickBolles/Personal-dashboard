"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, Dialog, Field, OverflowMenu, Spinner, cx, inputCls, useNow, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { ModelCombobox, type ModelChoice } from "@/components/areas/ModelPicker";
import { useWorkMutation } from "@/components/work/common";
import { type UndoOp } from "@/components/work/UndoBar";
import {
  AI_ACTIONS,
  AI_KIND_LABEL,
  DRAFT_KINDS,
  KIND_VERB,
  TERMINAL_JOB_STATES,
  usd2,
  type AiActionKind,
  type ItemAiResponse,
  type JobView,
  type ReportView,
  type ScheduleSlot,
  type UsageResponse,
} from "@/lib/ai";
import { CONTEXT_SOURCE_LABELS, CONTEXT_SOURCES, type ContextSource } from "@/lib/work";
import { SafeMarkdown, safeHref } from "./SafeMarkdown";

/**
 * Phase 5 AI task actions in the item workspace: "✦ Get started" split button
 * + action sheet, the job chip, the Reports section and the report viewer.
 * Hidden without work.ai or when the area excludes AI (Finance); the API
 * enforces both regardless.
 */

const itemAiKey = (id: string) => ["work", "ai", id] as const;

export function useItemAi(itemId: string, enabled = true) {
  return useQuery({
    queryKey: itemAiKey(itemId),
    queryFn: () => api.get<ItemAiResponse>(`/api/work/items/${encodeURIComponent(itemId)}/ai`),
    enabled,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => !TERMINAL_JOB_STATES.includes(j.state)) ? 3000 : false),
  });
}

const newClientKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
const lastActionKey = (areaId: string | null) => `jarvis.ai.last:${areaId ?? "none"}`;

function readLast(areaId: string | null): AiActionKind {
  try {
    const v = localStorage.getItem(lastActionKey(areaId));
    return v && v in AI_ACTIONS ? (v as AiActionKind) : "research";
  } catch {
    return "research";
  }
}

/** Split button: primary = last-used action in this area; the menu lists all four. */
export function GetStarted({ itemId, areaId, compact }: { itemId: string; areaId: string | null; compact?: boolean }) {
  const can = useAccess().can("work.ai");
  const q = useItemAi(itemId, can);
  const [sheet, setSheet] = useState<AiActionKind | null>(null);
  const [last] = useState<AiActionKind>(() => (typeof window === "undefined" ? "research" : readLast(areaId)));
  if (!can || !q.data?.policy.allowed) return null;
  return (
    <div className="flex items-stretch" data-testid="ai-get-started">
      <Button size="sm" variant="primary" className="rounded-r-none" onClick={() => setSheet(last)} title={AI_ACTIONS[last].description}>
        <span aria-hidden="true">✦</span> {compact ? "Get started" : `Get started · ${AI_ACTIONS[last].label.replace("…", "")}`}
      </Button>
      <div className="ai-split-menu">
        <OverflowMenu
          label="More AI actions"
          items={(Object.keys(AI_ACTIONS) as AiActionKind[]).map((k) => ({
            label: `${AI_ACTIONS[k].icon} ${AI_ACTIONS[k].label}`,
            onSelect: () => setSheet(k),
          }))}
        />
      </div>
      {sheet ? <ActionSheet itemId={itemId} areaId={areaId} action={sheet} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

/** Menu entries for the item's overflow menu (same actions). */
export function useAiMenuItems(itemId: string, onPick: (k: AiActionKind) => void) {
  const can = useAccess().can("work.ai");
  const q = useItemAi(itemId, can);
  if (!can || !q.data?.policy.allowed) return [];
  return (Object.keys(AI_ACTIONS) as AiActionKind[]).map((k) => ({ label: `✦ ${AI_ACTIONS[k].label}`, onSelect: () => onPick(k) }));
}

export function ActionSheet({
  itemId,
  areaId,
  action,
  onClose,
  rerunOf,
}: {
  itemId: string;
  areaId: string | null;
  action: AiActionKind;
  onClose: () => void;
  rerunOf?: ReportView;
}) {
  const meta = AI_ACTIONS[action];
  const [focus, setFocus] = useState("");
  const [model, setModel] = useState<ModelChoice>({});
  const [deep, setDeep] = useState(false);
  const [sources, setSources] = useState<ContextSource[]>([]);
  const [draftKind, setDraftKind] = useState<(typeof DRAFT_KINDS)[number]>("message");
  const [duration, setDuration] = useState("");
  const usage = useQuery({ queryKey: ["ai", "usage", 1], queryFn: () => api.get<UsageResponse>("/api/ai/usage?days=1"), staleTime: 15_000 });
  const qc = useQueryClient();
  const { toast } = useToast();
  const tier = action === "schedule" ? "triage" : deep ? "deep" : "standard";
  const estimate = tier === "triage" ? 0.01 : tier === "deep" ? 1 : 0.25;
  const t = usage.data?.today;
  const overBudget = t ? t.spentUsd + t.reservedUsd + estimate > t.budgetUsd : false;
  const start = useWorkMutation(
    () =>
      api.post<{ job: JobView }>(`/api/work/items/${encodeURIComponent(itemId)}/ai-actions`, {
        action,
        clientKey: newClientKey(),
        ...(model.model ? { model: model.model } : {}),
        ...(deep ? { deep: true } : {}),
        ...(focus.trim() ? { instructions: focus.trim() } : {}),
        ...(sources.length ? { contextSources: sources } : {}),
        ...(action === "draft" ? { draftKind } : {}),
        ...(action === "schedule" && Number(duration) >= 5 ? { durationHint: Number(duration) } : {}),
        ...(overBudget ? { budgetOverride: true } : {}),
      }),
    {
      onSuccess: () => {
        try {
          localStorage.setItem(lastActionKey(areaId), action);
        } catch {
          /* private mode */
        }
        qc.invalidateQueries({ queryKey: itemAiKey(itemId) });
        toast(`${KIND_VERB[action]}… you'll get a report`, "ok");
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={rerunOf ? `Re-run: ${meta.label.replace("…", "")}` : meta.label.replace("…", "")}
      description={meta.description}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted" data-dynamic>
            ≈ {usd2(estimate)}
            {t ? ` · today ${usd2(t.spentUsd)} of ${usd2(t.budgetUsd)}` : ""}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant={overBudget ? "danger" : "primary"} busy={start.isPending} onClick={() => start.mutate(undefined)} data-testid="ai-start">
              {overBudget ? "Run anyway" : "Start"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {action !== "schedule" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="wk-label">Tier</span>
            {(["standard", "deep"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={(v === "deep") === deep}
                onClick={() => setDeep(v === "deep")}
                className={cx(
                  "tap rounded-full border px-3 py-1 text-xs",
                  (v === "deep") === deep ? "border-accent bg-accent-soft font-semibold" : "border-line",
                )}
              >
                {v === "deep" ? "Deep" : "Standard"}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">Fast model estimates the effort. Your calendars are read by Jarvis only and never sent to AI.</p>
        )}
        <ModelCombobox backend="hermes" value={model} onChange={setModel} defaultHint="tier default" />
        <Field id="ai-focus" label="Focus (optional)">
          <textarea
            id="ai-focus"
            className={`${inputCls} min-h-20`}
            maxLength={1000}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="What should it look at or ignore?"
            data-autofocus
          />
        </Field>
        {action === "draft" ? (
          <Field id="ai-draft-kind" label="Kind">
            <select id="ai-draft-kind" className={inputCls} value={draftKind} onChange={(e) => setDraftKind(e.target.value as typeof draftKind)}>
              {DRAFT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {action === "schedule" ? (
          <Field id="ai-duration" label="Your duration guess (minutes, optional)">
            <input
              id="ai-duration"
              className={inputCls}
              inputMode="numeric"
              value={duration}
              onChange={(e) => setDuration(e.target.value.replace(/\D/g, "").slice(0, 4))}
            />
          </Field>
        ) : null}
        {action !== "schedule" ? (
          <fieldset>
            <legend className="wk-label pb-1">Context</legend>
            <div className="flex flex-wrap gap-1.5">
              {CONTEXT_SOURCES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sources.includes(s)}
                  onClick={() => setSources((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]))}
                  className={cx(
                    "tap rounded-full border px-3 py-1 text-xs",
                    sources.includes(s) ? "border-accent bg-accent-soft font-semibold" : "border-line",
                  )}
                >
                  {CONTEXT_SOURCE_LABELS[s]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">Finance is never sent to AI.</p>
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  );
}

function elapsed(from: string | null, now: number) {
  if (!from) return "";
  const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Status of the newest active (or just failed) job on the item. */
export function JobChip({ itemId }: { itemId: string }) {
  const can = useAccess().can("work.ai");
  const q = useItemAi(itemId, can);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: itemAiKey(itemId) });
  const cancel = useWorkMutation((id: string) => api.post<JobView>(`/api/ai/jobs/${id}/cancel`, {}), { onSuccess: refresh });
  const retry = useWorkMutation((id: string) => api.post<JobView>(`/api/ai/jobs/${id}/retry`, {}), { onSuccess: refresh });
  const anyway = useWorkMutation((id: string) => api.post<JobView>(`/api/ai/jobs/${id}/run-anyway`, {}), { onSuccess: refresh });
  const now = useNow(1000);
  const job =
    q.data?.jobs.find((j) => !TERMINAL_JOB_STATES.includes(j.state)) ??
    q.data?.jobs.find((j) => j.state === "failed" && now - Date.parse(j.finishedAt ?? j.createdAt) < 3600_000);
  if (!job) return null;
  const label = AI_KIND_LABEL[job.kind];
  return (
    <div
      role="status"
      data-testid="ai-job-chip"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-bg px-3 py-1.5 text-[13px]"
    >
      {job.state === "queued" || job.state === "running" ? (
        <>
          <Spinner />
          <span>
            {KIND_VERB[job.kind]}
            <span className="text-muted" data-dynamic>
              {job.state === "running" ? ` · ${elapsed(job.startedAt, now)}` : " · queued"}
            </span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate(job.id)}>
            Cancel
          </Button>
        </>
      ) : job.state === "cancelling" ? (
        <span>Stopping…</span>
      ) : job.state === "waiting_approval" ? (
        <>
          <span>Hermes needs approval</span>
          {job.conversationId ? (
            <a className="tap underline" href={`/chat/${encodeURIComponent(job.conversationId)}`}>
              Open conversation
            </a>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate(job.id)}>
            Cancel
          </Button>
        </>
      ) : job.state === "budget_blocked" ? (
        <>
          <span>Waiting for budget</span>
          <Button size="sm" variant="danger" onClick={() => anyway.mutate(job.id)}>
            Run anyway
          </Button>
        </>
      ) : (
        <>
          <span>
            {label} failed: {job.errorMessage ?? "unknown error"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => retry.mutate(job.id)}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}

const CONF_TONE = { low: "warn", medium: "neutral", high: "ok" } as const;

function ago(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export function ReportsSection({ itemId, areaId }: { itemId: string; areaId: string | null }) {
  const q = useItemAi(itemId);
  const [open, setOpen] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("report");
  });
  const [showOld, setShowOld] = useState(false);
  const reports = q.data?.reports ?? [];
  const current = reports.filter((r) => !r.supersededBy);
  const older = reports.filter((r) => r.supersededBy);
  if (!reports.length) return null;
  const row = (r: ReportView) => (
    <li key={r.id}>
      <button
        type="button"
        className="tap flex w-full min-w-0 flex-col items-start gap-0.5 py-2 text-left hover:bg-surface-2"
        onClick={() => setOpen(r.id)}
        data-testid="ai-report-row"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          {!r.readAt ? <span className="ai-unread-dot" aria-label="Unread" /> : null}
          <Badge tone="accent">{AI_KIND_LABEL[r.kind]}</Badge>
          <span className="min-w-0 truncate text-[14px] font-medium">{r.title}</span>
          <Badge tone={CONF_TONE[r.confidence]} dot>
            {r.confidence}
          </Badge>
        </span>
        {r.summary ? <span className="line-clamp-2 text-[13px] text-muted">{r.summary}</span> : null}
        <span className="text-xs text-muted" data-dynamic>
          {r.sourceCount} sources · {r.model ?? "default model"} · {usd2(r.costUsd)} · {ago(r.createdAt)}
        </span>
      </button>
    </li>
  );
  return (
    <section aria-labelledby="ai-reports-h" className="card" id="work-reports">
      <h3 id="ai-reports-h" className="font-semibold">
        Reports
      </h3>
      <ul className="wk-rows">{current.map(row)}</ul>
      {older.length ? (
        <>
          <button type="button" className="tap text-xs text-muted underline" aria-expanded={showOld} onClick={() => setShowOld((v) => !v)}>
            {showOld ? "Hide" : "Show"} {older.length} earlier report{older.length === 1 ? "" : "s"}
          </button>
          {showOld ? <ul className="wk-rows opacity-80">{older.map(row)}</ul> : null}
        </>
      ) : null}
      {open ? <ReportViewer reportId={open} itemId={itemId} areaId={areaId} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

export function ReportViewer({
  reportId,
  itemId,
  areaId,
  onClose,
  onOp,
}: {
  reportId: string;
  itemId?: string;
  areaId?: string | null;
  onClose: () => void;
  onOp?: (op: UndoOp | null) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rerun, setRerun] = useState(false);
  const q = useQuery({ queryKey: ["work", "ai-report", reportId], queryFn: () => api.get<ReportView>(`/api/ai/reports/${encodeURIComponent(reportId)}`) });
  const [marked, setMarked] = useState(false);
  const patch = useWorkMutation((body: Record<string, unknown>) => api.patch<ReportView>(`/api/ai/reports/${reportId}`, body));
  if (q.data && !q.data.readAt && !marked) {
    setMarked(true);
    void api.patch(`/api/ai/reports/${reportId}`, { read: true }).then(() => qc.invalidateQueries({ queryKey: ["work", "ai"] }));
  }
  const apply = useWorkMutation((body: Record<string, unknown>) => api.post<{ op: UndoOp | null }>(`/api/ai/reports/${reportId}/apply`, body), {
    onSuccess: (r) => {
      onOp?.(r.op);
      toast(r.op ? `${r.op.label}` : "Applied", "ok");
    },
  });
  const r = q.data;
  const st = (r?.structured ?? {}) as {
    next_actions?: { title: string; why?: string }[];
    steps?: { title: string; detail?: string; estimateHours?: number }[];
    slots?: ScheduleSlot[];
    options?: { name: string; pros?: string[]; cons?: string[]; fit?: string }[];
    recommendation?: string;
    subject?: string;
    open_questions?: string[];
    assumptions?: string[];
    durationMinutes?: number;
  };
  const [picked, setPicked] = useState<number[] | null>(null);
  const steps = st.steps ?? [];
  const sel = picked ?? steps.map((_, i) => i);
  const isItem = r?.subjectType === "work_item";
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={r ? r.title : "Report"}
      description={
        r ? (
          <span data-dynamic>
            {AI_KIND_LABEL[r.kind]} · {new Date(r.createdAt).toLocaleString()} · {r.model ?? "default model"} · {usd2(r.costUsd)} · confidence {r.confidence}
          </span>
        ) : undefined
      }
      footer={
        r ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {r.conversationId ? (
                <a
                  className="tap press inline-flex min-h-11 items-center rounded-[9px] border border-line px-3 text-sm"
                  href={`/chat/${encodeURIComponent(r.conversationId)}`}
                >
                  Continue in conversation
                </a>
              ) : null}
              {isItem && itemId && r.kind !== "triage" && r.kind !== "investigate" ? (
                <Button size="sm" onClick={() => setRerun(true)}>
                  Re-run…
                </Button>
              ) : null}
            </div>
            <div className="flex gap-1.5" role="group" aria-label="Was this useful?">
              <Button size="sm" aria-pressed={r.feedback?.value === "useful"} onClick={() => patch.mutate({ feedback: { value: "useful" } })}>
                Useful
              </Button>
              <Button size="sm" aria-pressed={r.feedback?.value === "not_useful"} onClick={() => patch.mutate({ feedback: { value: "not_useful" } })}>
                Not useful
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {!r ? (
        <Spinner label="Loading report…" />
      ) : (
        <div className="space-y-4 text-[14px]" data-testid="ai-report-viewer">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => patch.mutate({ pinned: !r.pinnedAt })}>
              {r.pinnedAt ? "Unpin" : "Pin"}
            </Button>
            <a
              className="tap press inline-flex min-h-11 items-center rounded-[9px] px-3 text-sm hover:bg-surface-2"
              href={`/api/ai/reports/${r.id}/export?format=md`}
              download
            >
              Export .md
            </a>
            <a
              className="tap press inline-flex min-h-11 items-center rounded-[9px] px-3 text-sm hover:bg-surface-2"
              href={`/api/ai/reports/${r.id}/export?format=json`}
              download
            >
              Export .json
            </a>
            <Button size="sm" variant="ghost" onClick={() => patch.mutate({ archived: !r.archivedAt }, { onSuccess: onClose })}>
              {r.archivedAt ? "Unarchive" : "Archive"}
            </Button>
          </div>
          {r.summary ? <p className="text-[15px]">{r.summary}</p> : null}
          {st.next_actions?.length ? (
            <section aria-labelledby="ai-na">
              <h4 id="ai-na" className="wk-label pb-1">
                Next actions
              </h4>
              <ul className="wk-rows">
                {st.next_actions.map((n, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0">
                      {n.title}
                      {n.why ? <span className="block text-xs text-muted">{n.why}</span> : null}
                    </span>
                    {isItem ? (
                      <Button size="sm" onClick={() => apply.mutate({ what: "next_action", index: i })}>
                        Use as next action
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {steps.length ? (
            <section aria-labelledby="ai-steps">
              <h4 id="ai-steps" className="wk-label pb-1">
                Plan
              </h4>
              <ol className="space-y-1">
                {steps.map((s, i) => (
                  <li key={i}>
                    <label className="tap flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={sel.includes(i)}
                        onChange={() => setPicked(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i].sort((a, b) => a - b))}
                      />
                      <span>
                        <strong>
                          {i + 1}. {s.title}
                        </strong>
                        {s.detail ? <span className="block text-xs text-muted">{s.detail}</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ol>
              {isItem ? (
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-2"
                  disabled={!sel.length}
                  busy={apply.isPending}
                  onClick={() => apply.mutate({ what: "plan_children", indexes: sel })}
                >
                  Create {sel.length} child item{sel.length === 1 ? "" : "s"}
                </Button>
              ) : null}
            </section>
          ) : null}
          {st.slots ? (
            <section aria-labelledby="ai-slots">
              <h4 id="ai-slots" className="wk-label pb-1">
                Suggested times {st.durationMinutes ? `(${st.durationMinutes} min)` : ""}
              </h4>
              {st.slots.length ? (
                <ul className="grid gap-2 sm:grid-cols-3">
                  {st.slots.map((s, i) => (
                    <li key={i} className="rounded-[10px] border border-line p-2" data-testid="ai-slot">
                      <p className="font-semibold" data-dynamic>
                        {new Date(s.start).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </p>
                      <p className="text-xs text-muted">{s.why}</p>
                      {isItem ? (
                        <Button size="sm" className="mt-1" onClick={() => apply.mutate({ what: "dates", slot: i })}>
                          Set dates
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No free slot in the next two weeks within your hours.</p>
              )}
            </section>
          ) : null}
          {st.options?.length ? (
            <section aria-labelledby="ai-opts" className="overflow-x-auto">
              <h4 id="ai-opts" className="wk-label pb-1">
                Options
              </h4>
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr>
                    <th scope="col">Option</th>
                    <th scope="col">Pros</th>
                    <th scope="col">Cons</th>
                  </tr>
                </thead>
                <tbody>
                  {st.options.map((o, i) => (
                    <tr key={i} className="align-top">
                      <th scope="row">{o.name}</th>
                      <td>{(o.pros ?? []).join("; ")}</td>
                      <td>{(o.cons ?? []).join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {st.recommendation ? <p className="mt-1">Recommendation: {st.recommendation}</p> : null}
            </section>
          ) : null}
          {r.kind === "draft" ? (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${st.subject ? `${st.subject}\n\n` : ""}${r.bodyMd}`).then(() => toast("Copied", "ok"));
                }}
              >
                Copy draft
              </Button>
            </div>
          ) : null}
          {r.bodyMd ? <SafeMarkdown text={r.bodyMd} sourceCount={r.sources?.length ?? 0} /> : null}
          {r.sources?.length ? (
            <section aria-labelledby="ai-src">
              <h4 id="ai-src" className="wk-label pb-1">
                Sources
              </h4>
              <ol className="space-y-1">
                {r.sources.map((s) => {
                  const href = s.url ? safeHref(s.url) : null;
                  return (
                    <li key={s.idx} id={`report-source-${s.idx + 1}`} className="text-[13px]">
                      <span className="text-muted">{s.idx + 1}. </span>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                          {s.title || href}
                        </a>
                      ) : (
                        s.title
                      )}
                      {href ? <span className="text-xs text-muted"> · {new URL(href).hostname}</span> : null}
                      {s.quote ? <span className="block text-xs text-muted">“{s.quote}”</span> : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          {st.open_questions?.length || st.assumptions?.length ? (
            <section aria-labelledby="ai-oq" className="text-[13px]">
              <h4 id="ai-oq" className="wk-label pb-1">
                Open questions & assumptions
              </h4>
              <ul className="ai-ul">
                {(st.open_questions ?? []).map((x, i) => (
                  <li key={`q${i}`}>{x}</li>
                ))}
                {(st.assumptions ?? []).map((x, i) => (
                  <li key={`a${i}`} className="text-muted">
                    Assumes: {x}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
      {rerun && r && itemId ? (
        <ActionSheet itemId={itemId} areaId={areaId ?? null} action={r.kind as AiActionKind} rerunOf={r} onClose={() => setRerun(false)} />
      ) : null}
    </Dialog>
  );
}
