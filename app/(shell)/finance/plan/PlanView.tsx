"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import type { PlanMode, PlanRow } from "@/lib/finance/plan";
import type { PlanView as Plan, ActualView } from "@/server/finance/plan";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, PageHeader, Spinner, cx, inputCls, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { Delta, Money, centsToInput, toCents } from "@/components/finance/money";

type Comment = { id: string; userId: string; body: string; createdAt: string };

function useSave<T>(fn: (v: T) => Promise<unknown>, ok?: string, after?: () => void) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (ok) toast(ok, "ok");
      qc.invalidateQueries({ queryKey: ["finance"] });
      after?.();
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
}

function AllocationFields({
  plan,
  values,
  onChange,
  idPrefix,
}: {
  plan: Plan;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {plan.funds.map((f) => (
        <Field key={f.id} id={`${idPrefix}-${f.id}`} label={f.name}>
          <input
            id={`${idPrefix}-${f.id}`}
            inputMode="decimal"
            className={inputCls}
            value={values[f.id] ?? ""}
            onChange={(e) => onChange({ ...values, [f.id]: e.target.value })}
            placeholder="0.00"
          />
        </Field>
      ))}
    </div>
  );
}

function parseAllocations(values: Record<string, string>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!v.trim()) continue;
    const c = toCents(v);
    if (c === undefined) throw new Error(`“${v}” isn't an amount`);
    out[k] = c;
  }
  return out;
}

function EventDialog({ plan, row, onClose }: { plan: Plan; row: PlanRow | "new" | null; onClose: () => void }) {
  const isNew = row === "new";
  const est = row && row !== "new" ? plan.estimates.find((e) => e.eventId === row.eventId) : undefined;
  const ev = row && row !== "new" ? plan.events.find((e) => e.id === row.eventId) : undefined;
  const [f, setF] = useState({ label: "", kind: "obligation", date: "", amount: "", alloc: {} as Record<string, string> });
  useEffect(() => {
    if (!row) return;
    setF({
      label: ev?.label ?? "",
      kind: ev?.kind ?? "obligation",
      date: est?.date ?? `${plan.year}-01-01`,
      amount: centsToInput(est?.amount),
      alloc: Object.fromEntries(Object.entries(est?.allocations ?? {}).map(([k, v]) => [k, centsToInput(v)])),
    });
  }, [row, ev, est, plan.year]);
  const save = useSave(
    () => {
      const amount = toCents(f.amount);
      if (amount === undefined) throw new Error("Enter the amount (income positive, obligations negative)");
      const allocations = parseAllocations(f.alloc);
      return isNew
        ? api.post(`/api/finance/plan/revisions/${plan.revision.id}/events`, { label: f.label, kind: f.kind, date: f.date, amount, allocations })
        : api.put(`/api/finance/plan/revisions/${plan.revision.id}/estimates`, { eventId: ev!.id, date: f.date, amount, allocations });
    },
    "Saved",
    onClose,
  );
  const remove = useSave(
    () =>
      api.put(`/api/finance/plan/revisions/${plan.revision.id}/estimates`, {
        eventId: ev!.id,
        date: est!.date,
        amount: est!.amount,
        allocations: est!.allocations,
        removed: true,
      }),
    "Removed from this revision",
    onClose,
  );
  return (
    <Dialog
      open={Boolean(row)}
      onClose={onClose}
      title={isNew ? "Add event" : `Estimate: ${ev?.label ?? ""}`}
      description={`In revision “${plan.revision.name}”. Income is positive, obligations negative; allocations should add up to the amount.`}
      size="lg"
      footer={
        <>
          {!isNew && est ? (
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(undefined)}>
              Remove from revision
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {isNew ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="ev-label" label="Event">
              <input
                id="ev-label"
                data-autofocus
                className={inputCls}
                value={f.label}
                onChange={(e) => setF({ ...f, label: e.target.value })}
                placeholder="RSU vest"
              />
            </Field>
            <Field id="ev-kind" label="Kind">
              <select id="ev-kind" className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="income">Income (RSU, bonus, ESPP…)</option>
                <option value="obligation">Obligation (taxes, insurance…)</option>
                <option value="reallocation">Reallocation between funds</option>
              </select>
            </Field>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ev-date" label="Planned date">
            <input id="ev-date" type="date" className={inputCls} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field id="ev-amount" label="Estimated amount">
            <input
              id="ev-amount"
              inputMode="decimal"
              className={inputCls}
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
              placeholder="-8000.00"
            />
          </Field>
        </div>
        <AllocationFields plan={plan} values={f.alloc} onChange={(alloc) => setF({ ...f, alloc })} idPrefix="ev-al" />
      </div>
    </Dialog>
  );
}

function ActualDialog({ plan, row, onClose }: { plan: Plan; row: PlanRow | null; onClose: () => void }) {
  const [f, setF] = useState({ date: "", amount: "", alloc: {} as Record<string, string>, note: "", complete: true });
  useEffect(() => {
    if (row) setF({ date: new Date().toISOString().slice(0, 10), amount: "", alloc: {}, note: "", complete: true });
  }, [row]);
  const save = useSave(
    () => {
      const amount = toCents(f.amount);
      if (amount === undefined) throw new Error("Enter the actual amount");
      const alloc = parseAllocations(f.alloc);
      const allocated = Object.values(alloc).reduce((s, v) => s + v, 0);
      const allocations = [
        ...Object.entries(alloc).map(([fundId, amount]) => ({ fundId, amount })),
        ...(amount !== allocated ? [{ fundId: null, amount: amount - allocated }] : []),
      ];
      return api.post(`/api/finance/plan/events/${row!.eventId}/actuals`, {
        date: f.date,
        amount,
        allocations,
        note: f.note || undefined,
        complete: f.complete,
      });
    },
    "Actual recorded",
    onClose,
  );
  return (
    <Dialog
      open={Boolean(row)}
      onClose={onClose}
      title={`Record actual: ${row?.label ?? ""}`}
      description="Actuals belong to the event and keep their own fund effects in every revision. Anything not assigned to a fund is stored as Unallocated."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            Record
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ac-date" label="Date">
            <input id="ac-date" data-autofocus type="date" className={inputCls} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field id="ac-amount" label="Actual amount (signed)">
            <input id="ac-amount" inputMode="decimal" className={inputCls} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        <AllocationFields plan={plan} values={f.alloc} onChange={(alloc) => setF({ ...f, alloc })} idPrefix="ac-al" />
        <Field id="ac-note" label="Note">
          <input id="ac-note" className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={f.complete} onChange={(e) => setF({ ...f, complete: e.target.checked })} />
          This completes the event (uncheck for one of several installments)
        </label>
      </div>
    </Dialog>
  );
}

function CorrectionDialog({ plan, actual, onClose }: { plan: Plan; actual: ActualView | null; onClose: () => void }) {
  const [f, setF] = useState({ fundId: "", amount: "", note: "" });
  const save = useSave(
    () => {
      const amount = toCents(f.amount);
      if (amount === undefined) throw new Error("Enter the amount to reallocate (signed)");
      return api.post(`/api/finance/plan/actuals/${actual!.id}/corrections`, { fundId: f.fundId || null, amount, note: f.note });
    },
    "Correction recorded",
    onClose,
  );
  return (
    <Dialog
      open={Boolean(actual)}
      onClose={onClose}
      title="Correct an actual's fund effects"
      description="Adds an audited reallocation row. History isn't edited."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            Record correction
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field id="co-fund" label="Fund">
          <select id="co-fund" data-autofocus className={inputCls} value={f.fundId} onChange={(e) => setF({ ...f, fundId: e.target.value })}>
            <option value="">Unallocated</option>
            {plan.funds.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="co-amount" label="Signed amount" hint="e.g. -500.00 to draw 500 more from the fund">
          <input id="co-amount" inputMode="decimal" className={inputCls} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field id="co-note" label="Why (required)">
          <input id="co-note" className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function Comments({ target, onClose }: { target: { type: string; id: string; title: string } | null; onClose: () => void }) {
  const [body, setBody] = useState("");
  const q = useQuery({
    queryKey: ["finance", "comments", target?.type, target?.id],
    queryFn: () => api.get<{ comments: Comment[] }>(`/api/finance/comments?type=${target!.type}&id=${encodeURIComponent(target!.id)}`),
    enabled: Boolean(target),
  });
  const add = useSave(
    () => api.post("/api/finance/comments", { type: target!.type, id: target!.id, body }),
    undefined,
    () => setBody(""),
  );
  return (
    <Dialog open={Boolean(target)} onClose={onClose} title={`Comments: ${target?.title ?? ""}`}>
      <ul className="space-y-2 text-sm">
        {q.data?.comments.map((c) => (
          <li key={c.id} className="rounded-lg bg-surface-2 p-2">
            <p>{c.body}</p>
            <p className="text-xs text-muted">{relativeTime(c.createdAt)}</p>
          </li>
        ))}
        {q.data && !q.data.comments.length ? <li className="text-muted">No comments yet.</li> : null}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate(undefined);
        }}
      >
        <label htmlFor="cm-body" className="sr-only">
          Comment
        </label>
        <input id="cm-body" data-autofocus className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment" />
        <Button type="submit" busy={add.isPending}>
          Post
        </Button>
      </form>
    </Dialog>
  );
}

function NewRevision({ plan, open, onClose }: { plan: Plan; open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ name: `Updated #${plan.revisions.length}`, changeNote: "" });
  const router = useRouter();
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/api/finance/plan/revisions", { year: plan.year, name: f.name, changeNote: f.changeNote, basedOnId: plan.revision.id }),
    onSuccess: (r) => {
      onClose();
      router.push(`/finance/plan?year=${plan.year}&revision=${r.id}`);
    },
  });
  const { toast } = useToast();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New revision"
      description={`Copies “${plan.revision.name}”. It starts hypothetical: it never affects check-ins until you promote it.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!f.changeNote.trim()}
            onClick={() => save.mutate(undefined, { onError: (e) => toast((e as Error).message, "danger") })}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field id="nr-name" label="Name">
          <input id="nr-name" data-autofocus className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field id="nr-note" label="What changed and why (required)">
          <textarea id="nr-note" className={`${inputCls} h-24`} value={f.changeNote} onChange={(e) => setF({ ...f, changeNote: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function ImportBlock({ open, onClose, year }: { open: boolean; onClose: () => void; year: number }) {
  const { toast } = useToast();
  const router = useRouter();
  const [f, setF] = useState({ year: String(year), name: "Imported", tab: "Yearly Projections", block: "Updated #3", range: "", csv: "" });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ revisionId: string; events: number; createdFunds: string[]; errors: { line: number; message: string }[] }>("/api/finance/plan/import", {
        ...f,
        year: Number(f.year),
      }),
    onSuccess: (r) => {
      toast(
        `Imported ${r.events} events${r.createdFunds.length ? `; new funds: ${r.createdFunds.join(", ")}` : ""}${r.errors.length ? `; ${r.errors.length} rows skipped` : ""}`,
        r.errors.length ? "warn" : "ok",
      );
      onClose();
      router.push(`/finance/plan?year=${f.year}&revision=${r.revisionId}`);
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import a spreadsheet block"
      description="Export one Yearly Projections block as CSV: date,label,kind,incoming,<fund>,… with Starting Position and Goal rows. It becomes a hypothetical revision marked imported and unreconciled, with its source recorded."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.isPending} disabled={!f.csv.trim() || !f.range.trim()} onClick={() => save.mutate()}>
            Import
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="ib-year" label="Plan year">
          <input id="ib-year" data-autofocus type="number" className={inputCls} value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} />
        </Field>
        <Field id="ib-name" label="Revision name">
          <input id="ib-name" className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field id="ib-tab" label="Sheet tab">
          <input id="ib-tab" className={inputCls} value={f.tab} onChange={(e) => setF({ ...f, tab: e.target.value })} />
        </Field>
        <Field id="ib-block" label="Block">
          <input id="ib-block" className={inputCls} value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} />
        </Field>
        <Field id="ib-range" label="Cell range">
          <input id="ib-range" className={inputCls} value={f.range} onChange={(e) => setF({ ...f, range: e.target.value })} placeholder="A40:K58" />
        </Field>
        <Field id="ib-file" label="CSV file">
          <input
            id="ib-file"
            type="file"
            accept=".csv,text/csv"
            className={inputCls}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setF({ ...f, csv: await file.text() });
            }}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field id="ib-csv" label="…or paste it">
            <textarea id="ib-csv" className={`${inputCls} h-28 font-mono text-xs`} value={f.csv} onChange={(e) => setF({ ...f, csv: e.target.value })} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

export function PlanView() {
  const sp = useSearchParams();
  const router = useRouter();
  const { can } = useAccess();
  const canEdit = can("finance.edit");
  const year = sp.get("year");
  const revision = sp.get("revision");
  const [mode, setMode] = useState<PlanMode>("forecast");
  const q = useQuery({
    queryKey: ["finance", "plan", year, revision, mode],
    queryFn: () =>
      api.get<Plan | { year: number; years: number[]; revision: null }>(
        `/api/finance/plan?mode=${mode}${year ? `&year=${year}` : ""}${revision ? `&revision=${encodeURIComponent(revision)}` : ""}`,
      ),
  });
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const [actualFor, setActualFor] = useState<PlanRow | null>(null);
  const [correcting, setCorrecting] = useState<ActualView | null>(null);
  const [comments, setComments] = useState<{ type: string; id: string; title: string } | null>(null);
  const [newRev, setNewRev] = useState(false);
  const [importing, setImporting] = useState(false);
  const startYear = useSave((y: number) => api.post("/api/finance/plan", { year: y }), "Plan year started");
  const promote = useSave(
    (p: Plan) => api.post(`/api/finance/plan/revisions/${p.revision.id}/promote`, { version: p.revision.version }),
    "This revision is now active",
  );
  const eventPatch = useSave((v: { id: string; version: number; body: Record<string, unknown> }) =>
    api.patch(`/api/finance/plan/events/${v.id}`, { ...v.body, version: v.version }),
  );
  if (q.isPending) return <Spinner label="Loading plan" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const go = (y: number, r?: string) => router.push(`/finance/plan?year=${y}${r ? `&revision=${r}` : ""}`);
  const thisYear = new Date().getFullYear();
  if (!q.data.revision) {
    const y = q.data.year;
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
        <PageHeader title="Long-term plan" subtitle="Irregular income and big obligations, mapped onto purpose funds." />
        <Empty
          title={`No plan for ${y} yet`}
          action={
            canEdit ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" busy={startYear.isPending} onClick={() => startYear.mutate(y, { onSuccess: () => go(y) })}>
                  Start {y}
                </Button>
                <Button onClick={() => setImporting(true)}>Import from the spreadsheet</Button>
              </div>
            ) : null
          }
        >
          Opening fund positions roll over from the previous year when it exists.
        </Empty>
        {q.data.years.length ? (
          <p className="text-sm">
            Other years:{" "}
            {q.data.years.map((x) => (
              <button key={x} type="button" className="mr-2 underline" onClick={() => go(x)}>
                {x}
              </button>
            ))}
          </p>
        ) : null}
        <ImportBlock open={importing} onClose={() => setImporting(false)} year={y || thisYear} />
      </div>
    );
  }
  const p = q.data as Plan;
  const r = p.result;
  const editable = canEdit && p.revision.editable;
  const event = (id: string) => p.events.find((e) => e.id === id)!;
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title={`${p.year} plan`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={p.revision.kind === "active" ? "ok" : p.revision.kind === "hypothetical" ? "accent" : "neutral"}>
              {p.revision.kind === "active"
                ? "Active"
                : p.revision.kind === "hypothetical"
                  ? "Hypothetical: never feeds check-ins"
                  : "Old revision (read-only)"}
            </Badge>
            {p.revision.provenance ? <Badge tone="warn">Imported, unreconciled</Badge> : null}
            <span>{p.revision.changeNote}</span>
          </span>
        }
        actions={
          canEdit ? (
            <>
              {p.revision.kind === "hypothetical" ? (
                <Button variant="primary" busy={promote.isPending} onClick={() => promote.mutate(p)}>
                  Make active
                </Button>
              ) : null}
              <Button onClick={() => setNewRev(true)}>New revision</Button>
              {editable ? <Button onClick={() => setEditing("new")}>Add event</Button> : null}
              <Button variant="ghost" onClick={() => setComments({ type: "revision", id: p.revision.id, title: p.revision.name })}>
                Comments
              </Button>
            </>
          ) : null
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field id="pl-year" label="Year">
          <select id="pl-year" className={inputCls} value={p.year} onChange={(e) => go(Number(e.target.value))}>
            {[...new Set([...p.years, thisYear, thisYear + 1])].sort().map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Field id="pl-rev" label="Revision">
          <select id="pl-rev" className={inputCls} value={p.revision.id} onChange={(e) => go(p.year, e.target.value)}>
            {p.revisions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.kind})
              </option>
            ))}
          </select>
        </Field>
        <div role="group" aria-label="Show" className="flex overflow-hidden rounded-xl border border-line-strong">
          {(["plan", "actual", "forecast"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cx("min-h-12 px-4 text-sm font-medium capitalize", mode === m ? "bg-accent text-accent-contrast" : "bg-surface hover:bg-surface-2")}
            >
              {m}
            </button>
          ))}
        </div>
        {canEdit ? (
          <Button variant="ghost" onClick={() => setImporting(true)}>
            Import block
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted">
        {mode === "plan"
          ? "Estimates in this revision."
          : mode === "actual"
            ? "Only what has happened, with its stored fund effects."
            : "What happened, plus estimates for the rest."}
      </p>
      <div data-scroll-x tabIndex={0} role="region" aria-label="Scrollable table" className="card relative overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {p.year} plan by event and fund ({mode})
          </caption>
          <thead className="bg-surface-2 text-left">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 py-2">
                Event
              </th>
              <th scope="col" className="px-3 py-2">
                Date
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Amount
              </th>
              {p.funds.map((f) => (
                <th key={f.id} scope="col" className="px-3 py-2 text-right">
                  {f.name}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right">
                Unallocated
              </th>
              <th scope="col" className="px-3 py-2">
                Variance
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line text-muted">
              <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium">
                Starting position
              </th>
              <td />
              <td />
              {p.funds.map((f) => (
                <td key={f.id} className="px-3 py-2 text-right" title={f.rolloverNote ?? undefined}>
                  <Money value={f.opening} />
                </td>
              ))}
              <td colSpan={2} />
            </tr>
            {r.rows.map((row) => {
              const ev = event(row.eventId);
              const actuals = p.actuals.filter((a) => a.eventId === row.eventId);
              return (
                <tr key={row.eventId} className="border-t border-line align-top">
                  <th scope="row" className="sticky left-0 z-10 min-w-56 bg-surface px-3 py-2 text-left font-normal">
                    <span className="font-medium">{row.label}</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge>{row.kind}</Badge>
                      {row.status !== "open" ? (
                        <Badge tone={row.status === "complete" ? "ok" : "accent"}>{row.status === "complete" ? "Done" : "Partly done"}</Badge>
                      ) : null}
                      {row.attention.map((a) => (
                        <Badge key={a} tone="warn">
                          {a}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      {editable && !row.notInRevision ? (
                        <button type="button" className="text-accent underline" onClick={() => setEditing(row)}>
                          Edit estimate
                        </button>
                      ) : null}
                      {canEdit && row.status !== "complete" ? (
                        <button type="button" className="text-accent underline" onClick={() => setActualFor(row)}>
                          Record actual
                        </button>
                      ) : null}
                      {canEdit && row.status === "partial" ? (
                        <button
                          type="button"
                          className="text-accent underline"
                          onClick={() => eventPatch.mutate({ id: ev.id, version: ev.version, body: { status: "complete" } })}
                        >
                          Mark done
                        </button>
                      ) : null}
                      {canEdit && ev.imported ? (
                        <button
                          type="button"
                          className="text-accent underline"
                          onClick={() => eventPatch.mutate({ id: ev.id, version: ev.version, body: { reconciled: true } })}
                        >
                          Reviewed
                        </button>
                      ) : null}
                      {canEdit
                        ? actuals.map((a) => (
                            <button key={a.id} type="button" className="text-accent underline" onClick={() => setCorrecting(a)}>
                              Correct {a.date} actual
                            </button>
                          ))
                        : null}
                      <button type="button" className="text-accent underline" onClick={() => setComments({ type: "event", id: ev.id, title: ev.label })}>
                        Comments
                      </button>
                    </div>
                  </th>
                  <td className="px-3 py-2">{row.date}</td>
                  <td className="px-3 py-2 text-right">
                    <Delta value={row.amount} />
                  </td>
                  {p.funds.map((f) => (
                    <td key={f.id} className="px-3 py-2 text-right">
                      {row.allocations[f.id] ? <Delta value={row.allocations[f.id]!} /> : null}
                    </td>
                  ))}
                  <td className={cx("px-3 py-2 text-right", row.unallocated !== 0 && "font-semibold text-warn")}>
                    {row.unallocated !== 0 ? (
                      <>
                        <Delta value={row.unallocated} /> <span className="sr-only">needs attention</span>
                      </>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {row.variance ? (
                      <>
                        Amount <Delta value={row.variance.amount} />
                        <br />
                        {row.variance.days === 0
                          ? "On time"
                          : `${Math.abs(row.variance.days)} day${Math.abs(row.variance.days) === 1 ? "" : "s"} ${row.variance.days > 0 ? "late" : "early"}`}
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-line-strong font-medium">
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left">
                Change
              </th>
              <td colSpan={2} />
              {p.funds.map((f) => (
                <td key={f.id} className="px-3 py-2 text-right">
                  <Delta value={r.change[f.id] ?? 0} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">{r.totalUnallocated ? <Delta value={r.totalUnallocated} /> : null}</td>
              <td />
            </tr>
            <tr className="border-t border-line">
              <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left">
                Ending position
              </th>
              <td colSpan={2} />
              {p.funds.map((f) => (
                <td key={f.id} className="px-3 py-2 text-right">
                  <Money value={r.endings[f.id]} strong />
                </td>
              ))}
              <td colSpan={2} />
            </tr>
            <tr className="border-t border-line">
              <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left">
                Diff from goal
              </th>
              <td colSpan={2} />
              {p.funds.map((f) => (
                <td key={f.id} className="px-3 py-2 text-right">
                  {r.diffFromGoal[f.id] === null ? <span className="text-muted">no goal</span> : <Delta value={r.diffFromGoal[f.id]!} />}
                </td>
              ))}
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      {editable ? (
        <details className="card p-4">
          <summary className="min-h-11 cursor-pointer font-medium">Opening positions and goals</summary>
          <Openings plan={p} />
        </details>
      ) : null}
      <EventDialog plan={p} row={editing} onClose={() => setEditing(null)} />
      <ActualDialog plan={p} row={actualFor} onClose={() => setActualFor(null)} />
      <CorrectionDialog plan={p} actual={correcting} onClose={() => setCorrecting(null)} />
      <Comments target={comments} onClose={() => setComments(null)} />
      <NewRevision plan={p} open={newRev} onClose={() => setNewRev(false)} />
      <ImportBlock open={importing} onClose={() => setImporting(false)} year={p.year} />
    </div>
  );
}

function Openings({ plan }: { plan: Plan }) {
  const [v, setV] = useState(() => Object.fromEntries(plan.funds.map((f) => [f.id, { opening: centsToInput(f.opening), goal: centsToInput(f.goal) }])));
  const save = useSave(async () => {
    for (const f of plan.funds) {
      const opening = toCents(v[f.id]?.opening || "0");
      const goal = v[f.id]?.goal ? toCents(v[f.id]!.goal) : null;
      if (opening === undefined || goal === undefined) throw new Error(`${f.name}: not an amount`);
      if (opening !== f.opening || goal !== f.goal) await api.put(`/api/finance/plan/revisions/${plan.revision.id}/openings`, { fundId: f.id, opening, goal });
    }
  }, "Saved");
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plan.funds.map((f) => (
          <fieldset key={f.id} className="rounded-xl border border-line p-3">
            <legend className="px-1 text-sm font-medium">{f.name}</legend>
            <Field id={`op-${f.id}`} label="Opening" hint={f.rolloverNote ?? undefined}>
              <input
                id={`op-${f.id}`}
                inputMode="decimal"
                className={inputCls}
                value={v[f.id]?.opening ?? ""}
                onChange={(e) => setV({ ...v, [f.id]: { ...v[f.id]!, opening: e.target.value } })}
              />
            </Field>
            <Field id={`gl-${f.id}`} label="Goal">
              <input
                id={`gl-${f.id}`}
                inputMode="decimal"
                className={inputCls}
                value={v[f.id]?.goal ?? ""}
                onChange={(e) => setV({ ...v, [f.id]: { ...v[f.id]!, goal: e.target.value } })}
              />
            </Field>
          </fieldset>
        ))}
      </div>
      <Button type="submit" busy={save.isPending}>
        Save openings and goals
      </Button>
    </form>
  );
}
