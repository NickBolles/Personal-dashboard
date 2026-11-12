"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Card, Checkbox, ErrorNote, Field, Input, KSpinner, PageHeader, Pill, Select, useToast } from "@/components/ui";
import { ModelCombobox } from "@/components/areas/ModelPicker";
import {
  BILLING_LABEL,
  BILLING_MODES,
  REASONING_EFFORTS,
  captureActions,
  usd2,
  type ReasoningEffort,
  type AiSettings,
  type BillingMode,
  type MeterView,
  type UsageResponse,
} from "@/lib/ai";

type View = {
  settings: AiSettings;
  runner: { armed: boolean; running: number; queued: number; budgetBlocked: number; lastTickAt: string | null; lastError: string | null };
  dispatcher: { running: boolean; lastRunAt: string | null; lastSent: number; lastError: string | null };
  today: { spentUsd: number; reservedUsd: number; day: string };
  meter: MeterView;
  hermesConfigured: boolean;
};

/** Settings → AI (admin): enable, budget/caps, models per tier, capture mode, Hermes capability flags, usage. */
export function AiSettingsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["settings", "ai"], queryFn: () => api.get<View>("/api/settings/ai") });
  const usage = useQuery({ queryKey: ["ai", "usage", 30], queryFn: () => api.get<UsageResponse>("/api/ai/usage?days=30") });
  const [busy, setBusy] = useState(false);
  if (q.isPending)
    return (
      <span role="status" className="inline-flex items-center gap-2">
        <KSpinner />
        Loading AI settings…
      </span>
    );
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const s = q.data.settings;
  const actions = captureActions(s);
  const save = async (patch: Partial<AiSettings>) => {
    setBusy(true);
    try {
      await api.put("/api/settings/ai", patch);
      qc.invalidateQueries({ queryKey: ["settings", "ai"] });
      toast("Saved", "ok");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);
  return (
    <div className="min-w-0 space-y-3 wrap-anywhere">
      <PageHeader title="AI" subtitle="Background research, plans, scheduling help, drafts and capture triage through Hermes." />
      <p className="rounded-lg border border-line bg-bg px-3 py-2 text-sm" role="note">
        Areas excluded from AI are never sent. Calendar data stays in Jarvis.
      </p>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">AI actions</h2>
            <p className="text-sm text-muted" data-dynamic>
              Runner {q.data.runner.armed ? "armed" : "off"} · {q.data.runner.running} running · {q.data.runner.queued} queued
              {q.data.runner.budgetBlocked ? ` · ${q.data.runner.budgetBlocked} waiting for budget` : ""} · push dispatcher{" "}
              {q.data.dispatcher.running ? "on" : "off"}
            </p>
            {!q.data.hermesConfigured ? <p className="text-sm text-danger">Hermes isn&apos;t configured yet (Settings → Connections).</p> : null}
          </div>
          <Checkbox label="Enabled" checked={s.enabled} disabled={busy} onChange={(enabled) => void save({ enabled })} />
        </div>
      </Card>
      <UsageMeterCard meter={q.data.meter} billing={s.billing} busy={busy} onSave={(billing) => void save({ billing })} />
      <Card>
        <h2 className="mb-2 font-semibold">Budget</h2>
        <p className="mb-2 text-sm text-muted" data-dynamic>
          Today {usd2(q.data.today.spentUsd)} spent{q.data.today.reservedUsd ? ` + ${usd2(q.data.today.reservedUsd)} running` : ""} of {usd2(s.dailyBudgetUsd)}.
          New jobs stop at the daily budget; each job offers Run anyway.
        </p>
        <form
          className="grid grid-cols-1 gap-2 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void save({
              dailyBudgetUsd: num(String(f.get("daily")), s.dailyBudgetUsd),
              jobCapsUsd: {
                triage: num(String(f.get("capT")), s.jobCapsUsd.triage),
                standard: num(String(f.get("capS")), s.jobCapsUsd.standard),
                deep: num(String(f.get("capD")), s.jobCapsUsd.deep),
              },
            });
          }}
        >
          <Field id="ai-daily" label="Daily budget ($)">
            <Input id="ai-daily" name="daily" className="w-full min-w-0" inputMode="decimal" defaultValue={s.dailyBudgetUsd} />
          </Field>
          <Field id="ai-capT" label="Cap: triage ($)">
            <Input id="ai-capT" name="capT" className="w-full min-w-0" inputMode="decimal" defaultValue={s.jobCapsUsd.triage} />
          </Field>
          <Field id="ai-capS" label="Cap: standard ($)">
            <Input id="ai-capS" name="capS" className="w-full min-w-0" inputMode="decimal" defaultValue={s.jobCapsUsd.standard} />
          </Field>
          <Field id="ai-capD" label="Cap: deep ($)">
            <Input id="ai-capD" name="capD" className="w-full min-w-0" inputMode="decimal" defaultValue={s.jobCapsUsd.deep} />
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit" loading={busy} className="max-w-full whitespace-normal">
              Save budget
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Models</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(["triage", "standard", "deep"] as const).map((t) => (
            <div key={t} className="grid min-w-0 grid-cols-1 gap-2">
              <ModelCombobox
                backend="hermes"
                label={t === "triage" ? "Fast (triage, schedule)" : t === "standard" ? "Standard" : "Deep (opt-in)"}
                value={{ model: s.models[t] ?? undefined, provider: s.providers[t] ?? undefined }}
                onChange={(v) =>
                  void save({
                    models: { ...s.models, [t]: v.model ?? null },
                    ...(v.provider ? { providers: { ...s.providers, [t]: v.provider } } : {}),
                  })
                }
                defaultHint="Hermes default"
              />
              <Field id={`ai-prov-${t}`} label={`Provider: ${t}`} hint="e.g. openai-codex. Blank: the profile's provider">
                <Input
                  id={`ai-prov-${t}`}
                  key={`${t}:${s.providers[t] ?? ""}`}
                  className="w-full min-w-0"
                  defaultValue={s.providers[t] ?? ""}
                  maxLength={80}
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== s.providers[t]) void save({ providers: { ...s.providers, [t]: v } });
                  }}
                />
              </Field>
              <Field id={`ai-reason-${t}`} label={`Reasoning: ${t}`}>
                <Select
                  id={`ai-reason-${t}`}
                  className="w-full min-w-0"
                  value={s.reasoning[t] ?? ""}
                  onChange={(e) => void save({ reasoning: { ...s.reasoning, [t]: (e.target.value || null) as ReasoningEffort | null } })}
                >
                  <option value="">Model default</option>
                  {REASONING_EFFORTS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Provider, model and reasoning are sent per run (needs &quot;Hermes honours a per-run model&quot;), so no Hermes aliases are needed.
        </p>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Captures</h2>
        <Field id="ai-capture" label="After a capture">
          <Select
            id="ai-capture"
            className="w-full min-w-0"
            value={s.capture.auto}
            onChange={(e) => void save({ capture: { ...s.capture, auto: e.target.value as AiSettings["capture"]["auto"] } })}
          >
            <option value="triage_and_investigate">Triage, then investigate when worthwhile</option>
            <option value="triage_only">Triage only</option>
            <option value="off">Nothing (file by hand)</option>
          </Select>
        </Field>
        <div className="mt-2">
          <Checkbox
            checked={actions.autoHandle}
            disabled={busy}
            onChange={(autoHandle) => void save({ capture: { ...s.capture, actions: { ...actions, autoHandle } } })}
            label={
              <span id="ai-capture-actions-auto-handle">
                Auto-handle captures
                <span className="block text-xs text-muted">
                  Jarvis does low-risk, undoable things itself (Skylight list items and events, Jarvis to-dos) and leaves the item ready to settle. Risky things
                  are only suggested.
                </span>
              </span>
            }
          />
        </div>
        <div className="mt-2 min-w-0">
          <Field id="ai-capture-actions-mode" label="When it can act">
            <Select
              id="ai-capture-actions-mode"
              className="w-full min-w-0"
              value={actions.mode}
              disabled={busy || !actions.autoHandle}
              onChange={(e) => void save({ capture: { ...s.capture, actions: { ...actions, mode: e.target.value as typeof actions.mode } } })}
            >
              <option value="act">Act</option>
              <option value="triage_only">Triage only, never act</option>
            </Select>
          </Field>
        </div>
        <fieldset className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1" aria-label="Capture action allowlist">
          {(
            [
              ["skylightList", "Skylight list items"],
              ["skylightEvent", "Skylight calendar events"],
              ["jarvisTask", "Jarvis to-dos"],
            ] as const
          ).map(([key, label]) => (
            <Checkbox
              key={key}
              label={<span id={`ai-capture-actions-${key}`}>{label}</span>}
              checked={actions.allow[key]}
              disabled={busy || !actions.autoHandle}
              onChange={(checked) => void save({ capture: { ...s.capture, actions: { ...actions, allow: { ...actions.allow, [key]: checked } } } })}
            />
          ))}
        </fieldset>
        <div className="mt-2">
          <Checkbox
            checked={s.capture.stripLocation}
            onChange={(stripLocation) => void save({ capture: { ...s.capture, stripLocation } })}
            label={
              <span>
                Remove location from captured photos
                <span className="block text-xs text-muted">
                  Removes GPS coordinates from photo metadata (JPEG, PNG, WebP) before saving. Off: photos are kept exactly as sent.
                </span>
              </span>
            }
          />
        </div>
        <p className="mt-2 text-xs text-muted">Dismissed captures, their photos and reports are deleted after 30 days. Filed captures stay with their item.</p>
      </Card>
      <Card>
        <h2 className="mb-1 font-semibold">Hermes capabilities</h2>
        <p className="mb-2 text-sm text-muted">
          Turn these on only after checking them against your Hermes (docs/integration-contracts.md). Off is the safe fallback.
        </p>
        {(
          [
            ["perRunModel", "Hermes honours a per-run model", "Off: every job uses the Hermes profile default model."],
            ["midRunCost", "Session cost updates while a run is going", "Off: the per-job cap is checked after the run; the timeout is the hard limit."],
            ["imageInput", "Runs accept image input", "Off: screenshots are listed as “not analysed”."],
          ] as const
        ).map(([k, label, hint]) => (
          <div key={k}>
            <Checkbox
              checked={s.hermes[k]}
              onChange={(checked) => void save({ hermes: { ...s.hermes, [k]: checked } })}
              label={
                <span>
                  {label}
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              }
            />
          </div>
        ))}
        <p className="mt-1 text-xs text-muted">
          Calendar writes for “Suggest a time”: <Pill>Off</Pill>
        </p>
      </Card>
      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Usage (30 days)</h2>
          <div className="flex min-w-0 flex-wrap gap-2 text-sm">
            <a className="tap underline" href="/api/ai/usage?days=30&format=csv">
              Export CSV
            </a>
            <a className="tap underline" href="/api/ai/usage?days=30&format=json">
              Export JSON
            </a>
          </div>
        </div>
        {usage.data ? (
          <>
            <p className="text-sm" data-dynamic>
              {usage.data.totals.jobs} jobs · {usd2(usage.data.totals.costUsd)}
              {usage.data.totals.overCap ? ` · ${usage.data.totals.overCap} over their cap` : ""}
            </p>
            <ul className="wk-rows mt-1 text-sm">
              {usage.data.days.slice(0, 10).map((d) => (
                <li key={d.day} className="flex flex-wrap justify-between gap-x-2 py-1" data-dynamic>
                  <span>{d.day}</span>
                  <span>
                    {d.jobs} jobs · {usd2(d.costUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <KSpinner />
        )}
      </Card>
    </div>
  );
}

const METER_TONE: Record<MeterView["state"], "ok" | "wn" | "bad"> = { api: "ok", ok: "ok", stop: "bad", stale: "wn", missing: "wn" };
const METER_BADGE: Record<MeterView["state"], string> = {
  api: "$ budget",
  ok: "Background AI on",
  stop: "Background AI paused",
  stale: "Usage stale",
  missing: "Usage unknown",
};

/** Settings → AI → Usage meter: billing mode + weekly subscription window (Hermes usage snapshot). */
function UsageMeterCard({
  meter,
  billing,
  busy,
  onSave,
}: {
  meter: MeterView;
  billing: AiSettings["billing"];
  busy: boolean;
  onSave: (b: AiSettings["billing"]) => void;
}) {
  const sub = meter.mode !== "api";
  const used = meter.usedPct ?? 0;
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Usage meter</h2>
        <Pill tone={METER_TONE[meter.state]} className="max-w-full whitespace-normal">
          {METER_BADGE[meter.state]}
        </Pill>
      </div>
      {sub ? (
        <div className="mb-2" data-testid="ai-usage-meter" data-state={meter.state}>
          <p className="text-sm font-semibold tabular-nums" data-dynamic>
            {meter.summary}
          </p>
          <div
            role="meter"
            aria-label={`${meter.label} weekly usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(used)}
            aria-valuetext={meter.usedPct == null ? "unknown" : `${Math.round(used)}% used, background AI stops at ${meter.stopAtPct}%`}
            className="relative mt-1 h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div className={meter.state === "ok" ? "h-full bg-ok" : "h-full bg-warn"} style={{ width: `${Math.min(100, used)}%` }} />
            <div aria-hidden="true" className="absolute top-0 h-full w-0.5 bg-text" style={{ left: `${meter.stopAtPct}%` }} />
          </div>
          <p className="mt-1 text-sm text-muted" data-dynamic>
            Background AI (capture triage, auto-investigate, Skylight and Daily Compass syncs) stops at {meter.stopAtPct}% of the week; chat and actions you
            start only warn.
            {meter.resetsAt ? ` Resets ${new Date(meter.resetsAt).toLocaleString()}.` : ""}
            {meter.fetchedAt ? ` Read ${new Date(meter.fetchedAt).toLocaleTimeString()}.` : ""}
          </p>
          {meter.warning ? (
            <p className="mt-1 text-sm text-warn" role="status">
              {meter.warning}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mb-2 text-sm text-muted">Pay per token: jobs are gated by the daily $ budget below.</p>
      )}
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        aria-label="Usage meter settings"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const stop = Number(f.get("stopAt"));
          onSave({ mode: String(f.get("mode")) as BillingMode, stopAtPct: Number.isFinite(stop) && stop >= 1 && stop <= 100 ? stop : billing.stopAtPct });
        }}
      >
        <Field id="ai-billing" label="Hermes billing">
          <Select id="ai-billing" name="mode" className="w-full min-w-0" defaultValue={billing.mode}>
            {BILLING_MODES.map((m) => (
              <option key={m} value={m}>
                {m === "api" ? BILLING_LABEL[m] : `${BILLING_LABEL[m]} subscription`}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="ai-stop-at" label="Stop background at (% of week)">
          <Input id="ai-stop-at" name="stopAt" className="w-full min-w-0" inputMode="decimal" defaultValue={billing.stopAtPct} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={busy} className="max-w-full whitespace-normal">
            Save meter
          </Button>
        </div>
      </form>
    </Card>
  );
}
