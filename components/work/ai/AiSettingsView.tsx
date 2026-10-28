"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, ErrorNote, Field, PageHeader, Spinner, inputCls, useToast } from "@/components/ui";
import { ModelCombobox } from "@/components/areas/ModelPicker";
import { BILLING_LABEL, BILLING_MODES, usd2, type AiSettings, type BillingMode, type MeterView, type UsageResponse } from "@/lib/ai";

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
  if (q.isPending) return <Spinner label="Loading AI settings…" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const s = q.data.settings;
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
    <div className="space-y-3">
      <PageHeader title="AI" subtitle="Background research, plans, scheduling help, drafts and capture triage through Hermes." />
      <p className="rounded-[10px] border border-line bg-bg px-3 py-2 text-[13px]" role="note">
        Finance is never sent to AI. Calendar data stays in Jarvis.
      </p>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">AI actions</h2>
            <p className="text-[13px] text-muted" data-dynamic>
              Runner {q.data.runner.armed ? "armed" : "off"} · {q.data.runner.running} running · {q.data.runner.queued} queued
              {q.data.runner.budgetBlocked ? ` · ${q.data.runner.budgetBlocked} waiting for budget` : ""} · push dispatcher{" "}
              {q.data.dispatcher.running ? "on" : "off"}
            </p>
            {!q.data.hermesConfigured ? <p className="text-[13px] text-danger">Hermes isn&apos;t configured yet (Settings → Connections).</p> : null}
          </div>
          <label className="tap inline-flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} />
            Enabled
          </label>
        </div>
      </Card>
      <UsageMeterCard meter={q.data.meter} billing={s.billing} busy={busy} onSave={(billing) => void save({ billing })} />
      <Card>
        <h2 className="mb-2 font-semibold">Budget</h2>
        <p className="mb-2 text-[13px] text-muted" data-dynamic>
          Today {usd2(q.data.today.spentUsd)} spent{q.data.today.reservedUsd ? ` + ${usd2(q.data.today.reservedUsd)} running` : ""} of {usd2(s.dailyBudgetUsd)}.
          New jobs stop at the daily budget; each job offers Run anyway.
        </p>
        <form
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
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
            <input id="ai-daily" name="daily" className={inputCls} inputMode="decimal" defaultValue={s.dailyBudgetUsd} />
          </Field>
          <Field id="ai-capT" label="Cap: triage ($)">
            <input id="ai-capT" name="capT" className={inputCls} inputMode="decimal" defaultValue={s.jobCapsUsd.triage} />
          </Field>
          <Field id="ai-capS" label="Cap: standard ($)">
            <input id="ai-capS" name="capS" className={inputCls} inputMode="decimal" defaultValue={s.jobCapsUsd.standard} />
          </Field>
          <Field id="ai-capD" label="Cap: deep ($)">
            <input id="ai-capD" name="capD" className={inputCls} inputMode="decimal" defaultValue={s.jobCapsUsd.deep} />
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit" busy={busy}>
              Save budget
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Models</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["triage", "standard", "deep"] as const).map((t) => (
            <ModelCombobox
              key={t}
              backend="hermes"
              label={t === "triage" ? "Fast (triage, schedule)" : t === "standard" ? "Standard" : "Deep (opt-in)"}
              value={{ model: s.models[t] ?? undefined }}
              onChange={(v) => void save({ models: { ...s.models, [t]: v.model ?? null } })}
              defaultHint="Hermes default"
            />
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Captures</h2>
        <Field id="ai-capture" label="After a capture">
          <select
            id="ai-capture"
            className={inputCls}
            value={s.capture.auto}
            onChange={(e) => void save({ capture: { ...s.capture, auto: e.target.value as AiSettings["capture"]["auto"] } })}
          >
            <option value="triage_and_investigate">Triage, then investigate when worthwhile</option>
            <option value="triage_only">Triage only</option>
            <option value="off">Nothing (file by hand)</option>
          </select>
        </Field>
        <label className="tap mt-2 flex items-start gap-2 py-1 text-[14px]">
          <input
            type="checkbox"
            checked={s.capture.stripLocation}
            onChange={(e) => void save({ capture: { ...s.capture, stripLocation: e.target.checked } })}
          />
          <span>
            Remove location from captured photos
            <span className="block text-xs text-muted">
              Removes GPS coordinates from photo metadata (JPEG, PNG, WebP) before saving. Off: photos are kept exactly as sent.
            </span>
          </span>
        </label>
        <p className="mt-2 text-xs text-muted">Dismissed captures, their photos and reports are deleted after 30 days. Filed captures stay with their item.</p>
      </Card>
      <Card>
        <h2 className="mb-1 font-semibold">Hermes capabilities</h2>
        <p className="mb-2 text-[13px] text-muted">
          Turn these on only after checking them against your Hermes (docs/integration-contracts.md). Off is the safe fallback.
        </p>
        {(
          [
            ["perRunModel", "Hermes honours a per-run model", "Off: every job uses the Hermes profile default model."],
            ["midRunCost", "Session cost updates while a run is going", "Off: the per-job cap is checked after the run; the timeout is the hard limit."],
            ["imageInput", "Runs accept image input", "Off: screenshots are listed as “not analysed”."],
          ] as const
        ).map(([k, label, hint]) => (
          <label key={k} className="tap flex items-start gap-2 py-1 text-[14px]">
            <input type="checkbox" checked={s.hermes[k]} onChange={(e) => void save({ hermes: { ...s.hermes, [k]: e.target.checked } })} />
            <span>
              {label}
              <span className="block text-xs text-muted">{hint}</span>
            </span>
          </label>
        ))}
        <p className="mt-1 text-xs text-muted">
          Calendar writes for “Suggest a time”: <Badge>Off</Badge>
        </p>
      </Card>
      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Usage (30 days)</h2>
          <div className="flex gap-2 text-[13px]">
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
            <p className="text-[13px]" data-dynamic>
              {usage.data.totals.jobs} jobs · {usd2(usage.data.totals.costUsd)}
              {usage.data.totals.overCap ? ` · ${usage.data.totals.overCap} over their cap` : ""}
            </p>
            <ul className="wk-rows mt-1 text-[13px]">
              {usage.data.days.slice(0, 10).map((d) => (
                <li key={d.day} className="flex justify-between py-1" data-dynamic>
                  <span>{d.day}</span>
                  <span>
                    {d.jobs} jobs · {usd2(d.costUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Spinner />
        )}
      </Card>
    </div>
  );
}

const METER_TONE: Record<MeterView["state"], "ok" | "warn" | "danger"> = { api: "ok", ok: "ok", stop: "danger", stale: "warn", missing: "warn" };
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
        <Badge tone={METER_TONE[meter.state]}>{METER_BADGE[meter.state]}</Badge>
      </div>
      {sub ? (
        <div className="mb-2" data-testid="ai-usage-meter" data-state={meter.state}>
          <p className="text-[14px] font-semibold tabular-nums" data-dynamic>
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
          <p className="mt-1 text-[13px] text-muted" data-dynamic>
            Background AI (capture triage, auto-investigate, Skylight and Daily Compass syncs) stops at {meter.stopAtPct}% of the week; chat and actions you
            start only warn.
            {meter.resetsAt ? ` Resets ${new Date(meter.resetsAt).toLocaleString()}.` : ""}
            {meter.fetchedAt ? ` Read ${new Date(meter.fetchedAt).toLocaleTimeString()}.` : ""}
          </p>
          {meter.warning ? (
            <p className="mt-1 text-[13px] text-warn" role="status">
              {meter.warning}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mb-2 text-[13px] text-muted">Pay per token: jobs are gated by the daily $ budget below.</p>
      )}
      <form
        className="grid gap-2 sm:grid-cols-3"
        aria-label="Usage meter settings"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const stop = Number(f.get("stopAt"));
          onSave({ mode: String(f.get("mode")) as BillingMode, stopAtPct: Number.isFinite(stop) && stop >= 1 && stop <= 100 ? stop : billing.stopAtPct });
        }}
      >
        <Field id="ai-billing" label="Hermes billing">
          <select id="ai-billing" name="mode" className={inputCls} defaultValue={billing.mode}>
            {BILLING_MODES.map((m) => (
              <option key={m} value={m}>
                {m === "api" ? BILLING_LABEL[m] : `${BILLING_LABEL[m]} subscription`}
              </option>
            ))}
          </select>
        </Field>
        <Field id="ai-stop-at" label="Stop background at (% of week)">
          <input id="ai-stop-at" name="stopAt" className={inputCls} inputMode="decimal" defaultValue={billing.stopAtPct} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={busy}>
            Save meter
          </Button>
        </div>
      </form>
    </Card>
  );
}
