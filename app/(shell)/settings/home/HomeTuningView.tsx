"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { WEIGHT_LABELS } from "@/lib/attention";
import { Button, ButtonLink, Card, Dialog, ErrorNote, Field, PageHeader, Spinner, cx, inputCls, useOnline, useToast } from "@/components/ui";
import { chatHref } from "@/components/home/chat";

type Tuning = {
  categories: { category: string; label: string; weight: number }[];
  tunable: { category: string; label: string }[];
  snoozed: { id: string; label: string; until: string }[];
  feedback: { id: string; label: string; verdictLabel: string; correction?: string; createdAt: string }[];
  milestones: { id: string; title: string; date: string; yearly: boolean; leadDays: number }[];
  budget: { now: number; today: number; upcoming: number };
  hermesBrief?: string;
};

const WEIGHTS = [1, 0, -1, -2];
const LEADS = [14, 30, 60, 90, 120];

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (d: string, yearly: boolean) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "long", day: "numeric", ...(yearly ? {} : { year: "numeric" }), timeZone: "UTC" });

/** Settings → Home priorities: every knob the ranking reads, all reversible, all per person. */
export function HomeTuningView() {
  const qc = useQueryClient();
  const online = useOnline();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["home-tuning"], queryFn: () => api.get<Tuning>("/api/home/tuning") });
  const [resetOpen, setResetOpen] = useState(false);
  const [m, setM] = useState({ title: "", date: "", yearly: true, leadDays: 60 });

  const done = (msg: string) => () => {
    toast(msg, "ok");
    qc.invalidateQueries({ queryKey: ["home-tuning"] });
    qc.invalidateQueries({ queryKey: ["home"] });
  };
  const fail = (e: unknown) => toast((e as Error).message, "danger");
  const weight = useMutation({
    mutationFn: (v: { category: string; weight: number }) => api.put("/api/home/tuning", v),
    onSuccess: done("Saved"),
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: (v: { scope: string; target?: string }) => api.del("/api/home/tuning", v),
    onSuccess: done("Reset"),
    onError: fail,
  });
  const forget = useMutation({
    mutationFn: (id: string) => api.del(`/api/home/feedback/${encodeURIComponent(id)}`),
    onSuccess: done("Forgotten"),
    onError: fail,
  });
  const addDate = useMutation({
    mutationFn: () => api.post("/api/home/milestones", m),
    onSuccess: () => {
      setM({ title: "", date: "", yearly: true, leadDays: 60 });
      done("Date saved")();
    },
    onError: fail,
  });
  const delDate = useMutation({
    mutationFn: (id: string) => api.del(`/api/home/milestones/${encodeURIComponent(id)}`),
    onSuccess: done("Date removed"),
    onError: fail,
  });

  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const t = q.data;
  const weightOf = (c: string) => t?.categories.find((x) => x.category === c)?.weight ?? 0;

  return (
    <div className="mx-auto w-full max-w-[880px] space-y-4 px-4 pt-4 pb-6 sm:px-6 dense:px-7 dense:pt-5">
      <PageHeader title="Home priorities" subtitle="What Home shows first, and what you’ve told it. Only you see this page." />
      {!t ? (
        <Spinner label="Loading…" />
      ) : (
        <>
          <Card>
            <h2 className="font-semibold">How Home decides</h2>
            <ul className="mt-2 space-y-1 text-sm text-muted">
              <li>
                · Now shows up to {t.budget.now}, Later today up to {t.budget.today}, and the next two weeks a preview of {t.budget.upcoming}. Everything else
                is counted in the backlog. Nothing is deleted or changed in its source.
              </li>
              <li>
                · Order: safety alerts, waiting on you, pinned, Daily Compass focus, overdue since yesterday, due within 4 hours, check-in window, due today.
              </li>
              <li>· Long-overdue tasks don’t take over Now: at most two fill spare room in Later today, and a suggestion offers to help triage.</li>
              <li>· Safety alerts are always shown. They can’t be hidden or ranked lower.</li>
              <li>· Every card has “Why this?” with the reasons and these same controls.</li>
            </ul>
          </Card>

          <Card>
            <h2 className="font-semibold">Categories</h2>
            <p className="mt-1 text-sm text-muted">“Less like this” moves a category down one step; “Helpful” moves it up one. Change it here any time.</p>
            <ul className="mt-3 divide-y divide-line">
              {t.tunable.map((c) => {
                const w = weightOf(c.category);
                return (
                  <li key={c.category} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="font-medium">{c.label}</span>
                    <div role="radiogroup" aria-label={`${c.label} ranking`} className="flex flex-wrap gap-1">
                      {WEIGHTS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={w === v}
                          disabled={!online || weight.isPending}
                          onClick={() => weight.mutate({ category: c.category, weight: v })}
                          className={cx(
                            "press min-h-11 rounded-full border px-3 text-xs font-medium disabled:opacity-50",
                            w === v ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2",
                          )}
                        >
                          {WEIGHT_LABELS[String(v)]}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Hidden for now</h2>
              {t.snoozed.length ? (
                <Button size="sm" variant="ghost" disabled={!online} onClick={() => reset.mutate({ scope: "snoozes" })}>
                  Show all again
                </Button>
              ) : null}
            </div>
            {t.snoozed.length ? (
              <ul className="mt-2 divide-y divide-line">
                {t.snoozed.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block truncate">{s.label}</span>
                      <span className="text-xs text-muted">until {fmtDate(s.until)}</span>
                    </span>
                    <Button size="sm" variant="secondary" disabled={!online} onClick={() => reset.mutate({ scope: "snooze", target: s.id })}>
                      Show again
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">Nothing hidden.</p>
            )}
          </Card>

          <Card>
            <h2 className="font-semibold">Saved dates</h2>
            <p className="mt-1 text-sm text-muted">
              Birthdays, anniversaries and other dates to plan ahead for. Only you see them; Home suggests planning when one is coming up. Jarvis never guesses
              these.
            </p>
            {t.milestones.length ? (
              <ul className="mt-2 divide-y divide-line">
                {t.milestones.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.title}</span>
                      <span className="text-xs text-muted">
                        {fmtDay(d.date, d.yearly)}
                        {d.yearly ? ", every year" : ""} · shown {d.leadDays} days ahead
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={!online} onClick={() => delDate.mutate(d.id)} aria-label={`Remove ${d.title}`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className="mt-3 grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                addDate.mutate();
              }}
            >
              <Field id="ms-title" label="What">
                <input
                  id="ms-title"
                  className={inputCls}
                  maxLength={80}
                  required
                  placeholder="e.g. Cassidy’s birthday"
                  value={m.title}
                  onChange={(e) => setM({ ...m, title: e.target.value })}
                />
              </Field>
              <Field id="ms-date" label="Date">
                <input id="ms-date" type="date" className={inputCls} required value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} />
              </Field>
              <Field id="ms-lead" label="Start suggesting">
                <select id="ms-lead" className={inputCls} value={m.leadDays} onChange={(e) => setM({ ...m, leadDays: Number(e.target.value) })}>
                  {LEADS.map((d) => (
                    <option key={d} value={d}>
                      {d} days before
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex min-h-12 items-center gap-2 self-end text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--accent)]"
                  checked={m.yearly}
                  onChange={(e) => setM({ ...m, yearly: e.target.checked })}
                />
                Every year
              </label>
              <div className="sm:col-span-2">
                <Button type="submit" variant="primary" busy={addDate.isPending} disabled={!online || !m.title.trim() || !m.date}>
                  Save date
                </Button>
              </div>
            </form>
          </Card>

          <Card>
            <h2 className="font-semibold">Your feedback</h2>
            {t.feedback.length ? (
              <ul className="mt-2 divide-y divide-line">
                {t.feedback.map((f) => (
                  <li key={f.id} className="flex items-start justify-between gap-2 py-2">
                    <span className="min-w-0 text-sm">
                      <span className="block">
                        <strong className="font-medium">{f.verdictLabel}</strong> · <span className="break-words">{f.label}</span>
                      </span>
                      {f.correction ? <span className="block text-muted">“{f.correction}”</span> : null}
                      <span className="text-xs text-muted">{fmtDate(f.createdAt)}</span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={!online} onClick={() => forget.mutate(f.id)} aria-label={`Forget feedback on ${f.label}`}>
                      Forget
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">No feedback yet. Use “Why this?” on any Home card.</p>
            )}
          </Card>

          {t.hermesBrief ? (
            <Card>
              <h2 className="font-semibold">Tune with Hermes</h2>
              <p className="mt-1 text-sm text-muted">
                Opens a chat with this page summarized (your corrections included, nothing from finance). Hermes can suggest changes; you apply them here. It
                runs only when you press send.
              </p>
              <ButtonLink
                className="mt-3"
                href={chatHref({
                  label: "Tune with Hermes",
                  context: t.hermesBrief,
                  draft:
                    "Help me tune what my Jarvis Home shows first. Read-only: don’t change anything. Suggest specific changes to my category settings or saved dates, and I’ll apply them myself.",
                })}
              >
                Tune with Hermes
              </ButtonLink>
            </Card>
          ) : null}

          <Card>
            <h2 className="font-semibold">Start over</h2>
            <p className="mt-1 text-sm text-muted">Resets categories, hidden items and feedback. Saved dates stay.</p>
            <Button className="mt-3" variant="danger" disabled={!online} onClick={() => setResetOpen(true)}>
              Reset Home priorities
            </Button>
          </Card>
          <Dialog
            open={resetOpen}
            onClose={() => setResetOpen(false)}
            title="Reset Home priorities?"
            description="Categories go back to normal, hidden items come back, and your feedback is forgotten. Saved dates and pins stay."
            footer={
              <>
                <Button variant="ghost" onClick={() => setResetOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  busy={reset.isPending}
                  onClick={() => {
                    reset.mutate({ scope: "all" });
                    setResetOpen(false);
                  }}
                >
                  Reset
                </Button>
              </>
            }
          />
        </>
      )}
    </div>
  );
}
