"use client";

import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { scheduleError, type SchedulesResponse } from "@/lib/client/away";
import { FEEDBACK_TRIAGE_TEMPLATE } from "@/lib/feedback";
import {
  AUTONOMY_LABELS,
  describeSchedule,
  JOB_KINDS,
  JOB_KIND_LABELS,
  JOB_STATUS_LABELS,
  jobInputSchema,
  jobsExportSchema,
  SUGGESTED_TEMPLATES,
  type JobInput,
  type JobKind,
  type ScheduledJob,
} from "@/lib/away";
import { Dialog, ErrorNote, Field, useToast, Button, Chip, ChipSelect, Dot, Pill, Segmented, Toast } from "@/components/ui";
import { inputCls, OverflowMenu } from "@/components/ui/legacy";

const endpoint = "/api/agents/schedules";
const jobPath = (job: ScheduledJob) => `${endpoint}/${encodeURIComponent(job.id)}`;
const fieldsOf = (job: ScheduledJob): JobInput => ({
  title: job.title,
  areaId: job.areaId,
  kind: job.kind,
  prompt: job.prompt,
  schedule: job.schedule,
  overnight: job.overnight,
  enabled: job.enabled,
});
const starters: Record<JobKind, string> = {
  brief: SUGGESTED_TEMPLATES[0].prompt,
  review: SUGGESTED_TEMPLATES[1].prompt,
  triage: "Review new Inbox captures and suggest where each belongs. If nothing changed, say exactly NOTHING_NEW.",
  stalled: "Check stalled or failed agent runs in this area. Suggest the next action. If nothing changed, say exactly NOTHING_NEW.",
  feedback: FEEDBACK_TRIAGE_TEMPLATE.prompt,
  custom: "",
};

export function ScheduledJobsCard() {
  const q = useQuery({ queryKey: ["agent-schedules"], queryFn: () => api.get<SchedulesResponse>(endpoint) });
  const qc = useQueryClient();
  const { toast } = useToast();
  const search = useSearchParams();
  const router = useRouter();
  const areaId = search.get("area");
  const file = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<ScheduledJob | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ job: ScheduledJob; action: "run" | "delete" | "pause"; reset?: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ message: string; perform: () => Promise<unknown> } | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["agent-schedules"] }), qc.invalidateQueries({ queryKey: ["away"] })]);
  const area = q.data?.areas.find((a) => a.id === areaId);
  const rows = q.data?.jobs.filter((job) => !areaId || job.areaId === areaId) ?? [];
  const closeConfirm = () => {
    confirm?.reset?.();
    setConfirm(null);
  };
  const onConfirm = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setError(null);
    const { job, action } = confirm;
    try {
      if (action === "run") {
        await api.post(`${jobPath(job)}/run`, { confirm: true });
        toast("Run started. Results land in While you were away.");
      } else if (action === "delete") {
        await api.del(jobPath(job));
        setUndo({ message: `Deleted ${job.title}`, perform: () => api.post(endpoint, fieldsOf(job)) });
      } else {
        await api.patch(jobPath(job), { enabled: false });
        setUndo({ message: `Paused ${job.title}`, perform: () => api.patch(jobPath(job), { enabled: true }) });
      }
      await refresh();
      closeConfirm();
    } catch (e) {
      setError(scheduleError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      id="schedules"
      aria-labelledby="schedules-heading"
      className="k-card @container min-w-0 scroll-mt-4 [overflow-wrap:anywhere] [&_button]:min-h-11 [&_button]:min-w-11 [&_[role=menu]]:min-w-0 [&_[role=menu]]:w-[min(12rem,calc(100vw-2rem))] [&_.k-toast]:flex-wrap [&_.k-toast]:max-w-full sm:[&_button]:min-h-10 sm:[&_button]:min-w-10 dense:[&_button]:min-h-6 dense:[&_button]:min-w-6"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 id="schedules-heading" className="min-w-0 flex-1 text-sm font-semibold">
          Scheduled jobs{" "}
          <span className="text-xs text-muted" data-dynamic>
            {q.data?.jobs.length ?? 0}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" disabled={!q.data} onClick={() => setEditing("new")}>
            New job
          </Button>
          <Button size="sm" variant="ghost" iconOnly icon="↑" aria-label="Import scheduled jobs file" onClick={() => file.current?.click()}>
            Import
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json"
            className="sr-only"
            aria-label="Import scheduled jobs"
            onChange={async (e) => {
              const selected = e.target.files?.[0];
              e.target.value = "";
              if (!selected) return;
              try {
                let raw: unknown;
                try {
                  raw = JSON.parse(await selected.text());
                } catch {
                  throw new Error("Choose a valid schedules JSON export");
                }
                const parsed = jobsExportSchema.safeParse(raw);
                if (!parsed.success) throw new Error("Choose a valid schedules JSON export");
                const payload = parsed.data;
                const result = await api.post<{ created: number; skipped: { title: string; reason: string }[] }>(`${endpoint}/import`, payload);
                toast(
                  `Imported ${result.created} jobs (off)${result.skipped.length ? `. Skipped: ${result.skipped.map((s) => `${s.title}: ${s.reason}`).join("; ")}` : ""}`,
                );
                await refresh();
              } catch (err) {
                toast(scheduleError(err), "danger");
              }
            }}
          />
          <a
            className="k-btn k-btn-ghost k-btn-sm k-btn-icon min-h-11 min-w-11 sm:min-h-10 sm:min-w-10 dense:min-h-6 dense:min-w-6"
            href={`${endpoint}/export`}
            download
            aria-label="Export scheduled jobs"
          >
            <span aria-hidden>↓</span>
          </a>
        </div>
      </header>
      {areaId ? (
        <div className="px-3 py-1">
          <Chip
            onRemove={() => {
              const params = new URLSearchParams(search);
              params.delete("area");
              router.replace(`/settings/agents${params.size ? `?${params}` : ""}#schedules`);
            }}
          >{`Area: ${area?.title ?? areaId}`}</Chip>
        </div>
      ) : null}
      {q.isPending ? (
        <p className="p-3 text-sm text-muted" role="status">
          Loading scheduled jobs…
        </p>
      ) : q.error ? (
        <ErrorNote error={q.error} retry={() => q.refetch()} />
      ) : (
        <ul className="divide-y divide-line" aria-label="Scheduled jobs">
          {rows.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              refresh={refresh}
              onEdit={() => setEditing(job)}
              onConfirm={(action, reset) => {
                setError(null);
                setConfirm({ job, action, reset });
              }}
            />
          ))}
          {!rows.length ? <li className="p-3 text-sm text-muted">No scheduled jobs here.</li> : null}
        </ul>
      )}
      <p className="border-t border-line px-3 py-2 text-xs text-muted">
        Schedules start off. Max 12 jobs · 6 runs a day · missed times are skipped · quiet hours: overnight jobs only · switched off after 5 failures.
      </p>
      {undo ? (
        <Toast
          message={undo.message}
          action={{
            label: "Undo",
            onClick: async () => {
              if (busy) return;
              setBusy(true);
              try {
                await undo.perform();
                setUndo(null);
                await refresh();
                toast("Undone");
              } catch (err) {
                toast(scheduleError(err), "danger");
              } finally {
                setBusy(false);
              }
            },
          }}
        />
      ) : null}
      {editing && q.data ? (
        <JobEditor
          key={editing === "new" ? "new" : editing.id}
          job={editing === "new" ? null : editing}
          initialArea={areaId}
          areas={q.data.areas}
          tz={q.data.tz}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            if (editing !== "new" && editing.enabled && !saved.enabled)
              setUndo({ message: `Paused ${saved.title}`, perform: () => api.patch(jobPath(editing), { enabled: true }) });
            setEditing(null);
            toast("Job saved");
            await refresh();
          }}
        />
      ) : null}
      {confirm ? (
        <Dialog
          open
          title={confirm.action === "run" ? "Run job now?" : confirm.action === "delete" ? "Delete scheduled job?" : "Pause scheduled job?"}
          onClose={() => !busy && closeConfirm()}
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={closeConfirm}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void onConfirm()}>
                {confirm.action === "run" ? "Run now" : confirm.action === "delete" ? "Delete job" : "Pause job"}
              </Button>
            </>
          }
        >
          <p className="font-semibold">{confirm.job.title}</p>
          <p className="mt-1 text-sm text-muted">
            {confirm.job.areaTitle ?? "Pick an area"} · {AUTONOMY_LABELS[confirm.job.autonomy]}
          </p>
          {confirm.action === "run" ? (
            <>
              <p className="mt-2 text-sm">
                {confirm.job.autonomy === "low_risk"
                  ? "May add notes and threads, update next actions and file to Inbox, with Undo. Other changes ask you."
                  : confirm.job.autonomy === "off"
                    ? "AI is off for this area."
                    : "Only suggests. Every change becomes a Needs-you decision."}
              </p>
              <p className="mt-2 text-sm text-muted">Runs once now on your Hermes subscription. Results land in While you were away.</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">You can Undo this change.</p>
          )}
          {error ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </section>
  );
}

function JobRow({
  job,
  refresh,
  onEdit,
  onConfirm,
}: {
  job: ScheduledJob;
  refresh: () => Promise<unknown>;
  onEdit: () => void;
  onConfirm: (action: "run" | "delete" | "pause", reset?: () => void) => void;
}) {
  const [override, setOverride] = useState<boolean>();
  const seq = useRef(0);
  const { toast } = useToast();
  const enabled = override ?? job.enabled;
  const toggle = async (checked: boolean) => {
    // Flip synchronously: controlled checkbox check() must not snap back while PATCH is in flight.
    setOverride(checked);
    const current = ++seq.current;
    if (!checked) {
      onConfirm("pause", () => setOverride(undefined));
      return;
    }
    try {
      await api.patch(jobPath(job), { enabled: checked });
      await refresh();
    } catch (err) {
      toast(scheduleError(err), "danger");
    } finally {
      if (seq.current === current) setOverride(undefined);
    }
  };
  return (
    <li className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 sm:min-h-10 dense:min-h-9" data-testid="scheduled-job">
      <label className="relative flex min-h-11 min-w-11 shrink-0 items-center justify-center sm:min-h-10 dense:min-h-6 dense:min-w-8">
        <input
          type="checkbox"
          role="switch"
          aria-label={`Enable ${job.title}`}
          checked={enabled}
          disabled={job.autonomy === "off"}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-5 w-8 appearance-none rounded-full border border-[var(--bdc)] bg-surface-2 checked:border-[var(--acb)] checked:bg-[var(--acb)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ac)] disabled:opacity-50"
        />
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 left-1/2 h-3 w-3 -translate-y-1/2 rounded-full ${enabled ? "translate-x-0 bg-white" : "-translate-x-3 bg-muted"}`}
        />
      </label>
      <div className="min-w-0 flex-1 basis-32">
        <span className="text-sm font-medium">{job.title}</span>
        <span className="block text-xs text-muted">{describeSchedule(job.schedule)}</span>
      </div>
      <Pill tone={job.areaId ? "neutral" : "wn"}>{job.areaTitle ?? "Pick an area"}</Pill>
      <Pill tone={job.autonomy === "off" ? "neutral" : "ai"}>{AUTONOMY_LABELS[job.autonomy]}</Pill>
      <span className="text-xs text-muted" data-dynamic>
        {enabled
          ? job.nextRunAt
            ? `Next ${new Date(job.nextRunAt).toLocaleString("en-GB", { timeZone: job.tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).replace(",", "")}`
            : "Next run pending"
          : "Paused"}
      </span>
      <span title={job.lastError ?? undefined}>
        <Pill tone={job.lastStatus === "failed" ? "bad" : job.lastStatus === "ok" || job.lastStatus === "running" ? "ai" : "neutral"}>
          <Dot tone={job.lastStatus === "failed" ? "bad" : "ai"} />
          {JOB_STATUS_LABELS[job.lastStatus]}
        </Pill>
      </span>
      <div className="ml-auto shrink-0">
        <OverflowMenu
          label={`More for scheduled job ${job.title}`}
          items={[
            { label: "Edit", onSelect: onEdit },
            { label: "Run now…", onSelect: () => onConfirm("run") },
            { label: "Delete…", danger: true, onSelect: () => onConfirm("delete") },
          ]}
        />
      </div>
    </li>
  );
}

function JobEditor({
  job,
  initialArea,
  areas,
  tz,
  onClose,
  onSaved,
}: {
  job: ScheduledJob | null;
  initialArea: string | null;
  areas: SchedulesResponse["areas"];
  tz: string;
  onClose: () => void;
  onSaved: (saved: JobInput) => Promise<void>;
}) {
  const [form, setForm] = useState<JobInput>(
    job
      ? fieldsOf(job)
      : {
          title: "",
          areaId: areas.some((a) => a.id === initialArea && a.autonomy !== "off") ? initialArea : null,
          kind: "brief",
          prompt: starters.brief,
          schedule: { freq: "daily", time: "07:30", days: [] },
          overnight: false,
          enabled: false,
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof JobInput>(key: K, value: JobInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const save = async () => {
    if (busy) return;
    const parsed = jobInputSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the job fields");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (job) await api.patch(jobPath(job), parsed.data);
      else await api.post(endpoint, parsed.data);
      await onSaved(parsed.data);
    } catch (err) {
      setError(scheduleError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={job ? "Edit scheduled job" : "New scheduled job"}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="scheduled-job-form" loading={busy}>
            Save job
          </Button>
        </>
      }
    >
      <form
        id="scheduled-job-form"
        className="@container min-w-0 space-y-3 [&_input]:min-w-0 [&_select]:min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field id="sj-title" label="Job title">
          <input id="sj-title" className={inputCls} required maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field id="sj-area" label="Job area">
          <select id="sj-area" className={inputCls} value={form.areaId ?? ""} onChange={(e) => set("areaId", e.target.value || null)}>
            <option value="">Pick an area</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id} disabled={area.autonomy === "off"}>
                {area.title}
                {area.autonomy === "off" ? " (AI off)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field id="sj-kind" label="Job kind">
          <ChipSelect
            id="sj-kind"
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value as JobKind;
              setForm((f) => ({ ...f, kind, prompt: !f.prompt.trim() || f.prompt === starters[f.kind] ? starters[kind] : f.prompt }));
            }}
          >
            {JOB_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {JOB_KIND_LABELS[kind]}
              </option>
            ))}
          </ChipSelect>
        </Field>
        <Field id="sj-prompt" label="Job prompt">
          <textarea
            id="sj-prompt"
            rows={5}
            className={inputCls}
            required
            maxLength={4000}
            value={form.prompt}
            onChange={(e) => set("prompt", e.target.value)}
          />
        </Field>
        <div className="min-w-0 [&_.k-seg]:flex-wrap">
          <Segmented
            label="Job frequency"
            value={form.schedule.freq}
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekdays", label: "Weekdays" },
              { value: "weekly", label: "Weekly" },
            ]}
            onChange={(freq) => set("schedule", { ...form.schedule, freq })}
          />
        </div>
        <Field id="sj-time" label="Job time" hint={`Times use ${tz}`}>
          <input
            id="sj-time"
            type="time"
            required
            className={inputCls}
            value={form.schedule.time}
            onChange={(e) => set("schedule", { ...form.schedule, time: e.target.value })}
          />
        </Field>
        {form.schedule.freq === "weekly" ? (
          <fieldset>
            <legend className="text-sm font-medium">Days</legend>
            <div className="flex flex-wrap gap-1">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, i) => (
                <Button
                  key={day}
                  size="sm"
                  aria-pressed={form.schedule.days.includes(i)}
                  onClick={() =>
                    set("schedule", {
                      ...form.schedule,
                      days: form.schedule.days.includes(i) ? form.schedule.days.filter((d) => d !== i) : [...form.schedule.days, i],
                    })
                  }
                >
                  {day}
                </Button>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={form.overnight} onChange={(e) => set("overnight", e.target.checked)} />
          Can run overnight (inside quiet hours)
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Job enabled
        </label>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
