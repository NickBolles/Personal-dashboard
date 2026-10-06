"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import type { CheckinResult, GridRow } from "@/lib/finance/engine";
import {
  ACTION_KIND_LABELS,
  ACTION_KINDS,
  INTERNAL_KINDS,
  issueKey,
  type ActionKind,
  type ActionStatus,
  type Fund,
  type Inclusion,
  type Issue,
  type ReserveSettings,
} from "@/lib/finance/types";
import { Badge, Button, Card, Dialog, ErrorNote, Field, PageHeader, Spinner, cx, inputCls, useToast } from "@/components/ui";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { Delta, Money, centsToInput, fmt, toCents, useHideAmounts } from "@/components/finance/money";
import type { AccountView } from "@/server/finance/accounts";
import type { ActionView, CheckinView as Checkin } from "@/server/finance/checkins";
import type { MatchProposal } from "@/server/finance/sync";

type Txn = {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  pending: boolean;
  ambiguous: boolean;
  matched: { actionId: string; side: string } | null;
};
type Payload = {
  checkin: Checkin;
  accounts: AccountView[];
  funds: (Fund & { version: number })[];
  settings: ReserveSettings;
  transactions: Txn[];
  proposals: MatchProposal[];
  planEvents: { eventId: string; label: string; date: string; year: number }[];
};

const STATUS_LABEL: Record<ActionStatus, string> = {
  planned: "Planned",
  initiated: "In progress",
  settled: "Done",
  skipped: "Skipped",
  cancelled: "Cancelled",
};
const INCLUSION_LABEL: Record<Inclusion, string> = { included: "In the snapshot", excluded: "Not in the snapshot yet", unknown: "Not sure: confirm" };

function IssueList({ issues, checkinId, acknowledged, editable }: { issues: Issue[]; checkinId: string; acknowledged: string[]; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ack = useMutation({
    mutationFn: (key: string) => api.post(`/api/finance/checkins/${checkinId}/acknowledge`, { key, note: "Reviewed" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  if (!issues.length) return null;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Issues</h2>
      <ul className="space-y-2">
        {issues.map((i) => {
          const key = issueKey(i);
          const done = acknowledged.includes(key);
          return (
            <li key={key} className="flex flex-wrap items-start gap-2 text-sm">
              {i.blocking ? (
                <Badge tone="danger">
                  <AlertIcon className="h-3.5 w-3.5" /> Must fix
                </Badge>
              ) : done ? (
                <Badge tone="ok">
                  <CheckIcon className="h-3.5 w-3.5" /> Acknowledged
                </Badge>
              ) : (
                <Badge tone="warn">
                  <AlertIcon className="h-3.5 w-3.5" /> Warning
                </Badge>
              )}
              <span className="min-w-0 flex-1">{i.message}</span>
              {!i.blocking && !done && editable ? (
                <Button size="sm" busy={ack.isPending && ack.variables === key} onClick={() => ack.mutate(key)}>
                  Acknowledge
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

type Draft = {
  id?: string;
  version?: number;
  kind: ActionKind;
  label: string;
  amount: string;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  fundId: string;
  fundDecision: boolean;
  flowId: string;
  cardBasis: string;
  planEventId: string;
  note: string;
};

const emptyDraft = (): Draft => ({
  kind: "card_payment",
  label: "",
  amount: "",
  fromAccountId: "",
  toAccountId: "",
  date: "",
  fundId: "",
  fundDecision: false,
  flowId: "",
  cardBasis: "",
  planEventId: "",
  note: "",
});

function ActionDialog({ draft, onClose, data }: { draft: Draft | null; onClose: () => void; data: Payload }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [d, setD] = useState<Draft>(draft ?? emptyDraft());
  useEffect(() => {
    if (draft) setD(draft);
  }, [draft]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const amount = toCents(d.amount);
      if (amount === undefined) throw new Error("Enter the amount, like 1500.00");
      const body = {
        kind: d.kind,
        label: d.label,
        amount: d.kind === "adjustment" ? amount : Math.abs(amount),
        fromAccountId: d.fromAccountId || null,
        toAccountId: d.toAccountId || null,
        date: d.date || null,
        fundId: d.fundId || null,
        fundDecision: d.fundDecision,
        flowId: d.flowId || null,
        cardBasis: d.cardBasis || null,
        planEventId: d.planEventId || null,
        note: d.note || null,
      };
      return d.id
        ? api.patch(`/api/finance/actions/${d.id}`, { ...body, version: d.version })
        : api.post(`/api/finance/checkins/${data.checkin.id}/actions`, body);
    },
    onSuccess: () => {
      toast(d.id ? "Action saved" : "Action added", "ok");
      qc.invalidateQueries({ queryKey: ["finance"] });
      onClose();
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const accounts = data.accounts.filter((a) => !a.archived);
  const needsFrom = d.kind === "transfer" || d.kind === "card_payment" || d.kind === "external_outflow";
  const needsTo = d.kind !== "external_outflow";
  const fund = data.funds.find((f) => f.id === d.fundId);
  const schedule = data.checkin.result.reserve.schedule;
  return (
    <Dialog
      open={Boolean(draft)}
      onClose={onClose}
      title={d.id ? "Edit action" : "Add action"}
      description="Plans and records only. Jarvis never moves money."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="ad-kind" label="Kind">
          <select id="ad-kind" data-autofocus className={inputCls} value={d.kind} onChange={(e) => set({ kind: e.target.value as ActionKind })}>
            {ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="ad-label" label="Label">
          <input id="ad-label" className={inputCls} value={d.label} onChange={(e) => set({ label: e.target.value })} placeholder="Pay Visa" />
        </Field>
        <Field
          id="ad-amount"
          label="Amount"
          hint={d.kind === "adjustment" ? "Signed: negative reduces the account." : "Positive; the kind sets the direction."}
        >
          <input
            id="ad-amount"
            inputMode="decimal"
            className={inputCls}
            value={d.amount}
            onChange={(e) => set({ amount: e.target.value })}
            placeholder="1500.00"
          />
        </Field>
        <Field id="ad-date" label="Date" hint="Needed for the day-by-day cash check.">
          <input id="ad-date" type="date" className={inputCls} value={d.date} onChange={(e) => set({ date: e.target.value })} />
        </Field>
        {needsFrom ? (
          <Field id="ad-from" label={d.kind === "external_outflow" ? "Account" : "From"}>
            <select id="ad-from" className={inputCls} value={d.fromAccountId} onChange={(e) => set({ fromAccountId: e.target.value })}>
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {needsTo ? (
          <Field id="ad-to" label={INTERNAL_KINDS.includes(d.kind) ? "To" : "Account"}>
            <select id="ad-to" className={inputCls} value={d.toAccountId} onChange={(e) => set({ toAccountId: e.target.value })}>
              <option value="">Choose…</option>
              {accounts
                .filter((a) => d.kind !== "card_payment" || a.kind === "credit_card")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        {d.kind === "card_payment" ? (
          <Field id="ad-basis" label="Card basis for this payment" hint="Defaults to the card's chosen basis.">
            <select id="ad-basis" className={inputCls} value={d.cardBasis} onChange={(e) => set({ cardBasis: e.target.value })}>
              <option value="">Card’s setting</option>
              <option value="statement">Statement balance</option>
              <option value="current">Current balance</option>
            </select>
          </Field>
        ) : null}
        <Field id="ad-fund" label="Purpose fund it draws on" hint="Independent of the account it's paid from.">
          <select id="ad-fund" className={inputCls} value={d.fundId} onChange={(e) => set({ fundId: e.target.value })}>
            <option value="">None</option>
            {data.funds
              .filter((f) => !f.archived)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.protected ? " (protected)" : ""}
                </option>
              ))}
          </select>
        </Field>
        {fund?.protected ? (
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={d.fundDecision} onChange={(e) => set({ fundDecision: e.target.checked })} />
            We decided to use the protected {fund.name} fund for this
          </label>
        ) : null}
        {schedule.length || d.flowId ? (
          <Field id="ad-flow" label="Covers a scheduled bill" hint="So it isn't counted in the reserve as well.">
            <select id="ad-flow" className={inputCls} value={d.flowId} onChange={(e) => set({ flowId: e.target.value })}>
              <option value="">No</option>
              {d.flowId && !schedule.some((s) => s.flowId === d.flowId) ? <option value={d.flowId}>{d.flowId}</option> : null}
              {schedule
                .filter((s) => s.amount < 0)
                .map((s) => (
                  <option key={s.flowId} value={s.flowId}>
                    {s.label} · {s.date}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        {data.planEvents.length ? (
          <Field id="ad-plan" label="Long-term plan event" hint="Marking it done records the actual.">
            <select id="ad-plan" className={inputCls} value={d.planEventId} onChange={(e) => set({ planEventId: e.target.value })}>
              <option value="">None</option>
              {data.planEvents.map((p) => (
                <option key={p.eventId} value={p.eventId}>
                  {p.label} · {p.date}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field id="ad-note" label="Note" hint={d.kind === "adjustment" ? "Required: what this corrects." : "e.g. “after paycheck”"}>
          <input id="ad-note" className={inputCls} value={d.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function draftFrom(a: ActionView): Draft {
  return {
    id: a.id,
    version: a.version,
    kind: a.kind,
    label: a.label,
    amount: centsToInput(a.amount),
    fromAccountId: a.fromAccountId ?? "",
    toAccountId: a.toAccountId ?? "",
    date: a.date ?? "",
    fundId: a.fundId ?? "",
    fundDecision: Boolean(a.fundDecision),
    flowId: a.flowId ?? "",
    cardBasis: a.cardBasis ?? "",
    planEventId: a.planEventId ?? "",
    note: a.note ?? "",
  };
}

function LegEditor({ action, data, editable }: { action: ActionView; data: Payload; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (v: { side: string; inclusion: Inclusion }) =>
      api.post(`/api/finance/actions/${action.id}/legs`, { side: v.side, inclusion: v.inclusion, evidence: evidence[v.side] ?? "" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const name = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? "?";
  return (
    <ul className="space-y-3">
      {action.legDetails.map((l) => (
        <li key={l.side} className="rounded-xl border border-line p-3 text-sm">
          <p className="font-medium">
            {l.side === "source" ? "Leaves" : "Arrives in"} {name(l.accountId)}:{" "}
            <span className={cx(l.inclusion === "unknown" && "text-warn")}>{INCLUSION_LABEL[l.inclusion]}</span>
          </p>
          {l.evidence ? <p className="text-muted">Evidence: {l.evidence}</p> : null}
          {editable ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field id={`ev-${action.id}-${l.side}`} label="How you know">
                <input
                  id={`ev-${action.id}-${l.side}`}
                  className={inputCls}
                  value={evidence[l.side] ?? ""}
                  onChange={(e) => setEvidence((x) => ({ ...x, [l.side]: e.target.value }))}
                  placeholder="Card shows it on 10/02"
                />
              </Field>
              <Button size="sm" onClick={() => save.mutate({ side: l.side, inclusion: "included" })}>
                It’s in the balance
              </Button>
              <Button size="sm" onClick={() => save.mutate({ side: l.side, inclusion: "excluded" })}>
                Not yet
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ActionDetails({ action, data, onEdit, editable }: { action: ActionView; data: Payload; onEdit: () => void; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/finance/actions/${action.id}`, { ...body, version: action.version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/finance/actions/${action.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
    onError: (e) => toast((e as Error).message, "danger"),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {STATUS_LABEL[action.status]}
        {action.doneAt ? ` · done ${relativeTime(action.doneAt)}` : ""}
        {action.note ? ` · ${action.note}` : ""}
        {action.carriedFromId ? " · carried from last month" : ""}
      </p>
      <LegEditor action={action} data={data} editable={editable} />
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {action.status !== "settled" ? (
            <Button size="sm" variant="primary" busy={patch.isPending} onClick={() => patch.mutate({ status: "settled" })}>
              Mark done
            </Button>
          ) : (
            <Button size="sm" busy={patch.isPending} onClick={() => patch.mutate({ status: "planned" })}>
              Not done after all
            </Button>
          )}
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          {action.status === "planned" ? (
            <Button size="sm" onClick={() => patch.mutate({ status: "skipped" })}>
              Skip this month
            </Button>
          ) : null}
          <Button size="sm" variant="danger" busy={del.isPending} onClick={() => del.mutate()}>
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function rowLabels(r: GridRow) {
  return (
    <>
      {r.external ? <Badge>External</Badge> : null}
      {r.inTransit ? <Badge tone="accent">In transit</Badge> : null}
      {r.unknown ? <Badge tone="warn">Snapshot? confirm</Badge> : null}
      {r.status === "settled" ? <Badge tone="ok">Done</Badge> : r.status === "initiated" ? <Badge tone="accent">In progress</Badge> : null}
    </>
  );
}

function Grid({ data, onOpen }: { data: Payload; onOpen: (id: string) => void }) {
  const r = data.checkin.result;
  const cols = data.accounts.filter((a) => r.accounts.some((s) => s.accountId === a.id));
  const sum = (id: string) => r.accounts.find((a) => a.accountId === id)!;
  const row = (g: GridRow, anticipated = false) => (
    <tr key={g.actionId} id={g.actionId} className={cx("border-t border-line", anticipated && "italic text-muted")}>
      <th scope="row" className="sticky left-0 z-10 min-w-48 bg-surface px-3 py-2 text-left font-normal">
        <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={() => onOpen(g.actionId)}>
          {g.label}
        </button>
        <div className="mt-1 flex flex-wrap gap-1">{anticipated ? <Badge>Anticipated</Badge> : rowLabels(g)}</div>
        {g.unbalanced ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            Not balanced: {g.unbalanced}
          </p>
        ) : null}
      </th>
      <td className="px-3 py-2 text-sm">{g.date ?? <span className="text-danger">needs a date</span>}</td>
      {cols.map((c) => (
        <td key={c.id} className="px-3 py-2 text-right">
          {g.deltas[c.id] !== undefined ? <Delta value={g.deltas[c.id]!} /> : null}
        </td>
      ))}
      <td className="px-3 py-2 text-right">
        <Delta value={g.rowNet} />
      </td>
      <td className="px-3 py-2 text-right">{anticipated ? "—" : <Money value={g.runningNet} />}</td>
      <td className="px-3 py-2 text-right">{anticipated ? "—" : <Money value={g.runningLiquid} />}</td>
    </tr>
  );
  return (
    <div data-scroll-x tabIndex={0} role="region" aria-label="Scrollable table" className="card relative overflow-x-auto p-0">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Check-in actions by account, with running Net position and Liquid cash</caption>
        <thead>
          <tr className="bg-surface-2 text-left">
            <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 py-2">
              Action
            </th>
            <th scope="col" className="px-3 py-2">
              Date
            </th>
            {cols.map((c) => (
              <th key={c.id} scope="col" className="px-3 py-2 text-right">
                {c.name}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right">
              Row net
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Net position
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Liquid cash
            </th>
          </tr>
        </thead>
        <tbody>
          {r.rows.length ? (
            r.rows.map((g) => row(g))
          ) : (
            <tr>
              <td colSpan={cols.length + 5} className="px-3 py-4 text-center text-muted">
                No actions yet.
              </td>
            </tr>
          )}
        </tbody>
        {r.ifReceived.length ? (
          <tbody>
            <tr className="border-t-2 border-line-strong">
              <th scope="rowgroup" colSpan={cols.length + 5} className="px-3 pt-3 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                If received (anticipated, not in totals)
              </th>
            </tr>
            {r.ifReceived.map((g) => row(g, true))}
          </tbody>
        ) : null}
        <tfoot className="border-t-2 border-line-strong font-medium">
          {(
            [
              ["Starting balance", (id: string) => sum(id).start, r.starting],
              ["Total change", (id: string) => sum(id).change, r.change],
              ["Ending balance", (id: string) => sum(id).end, r.ending],
            ] as const
          ).map(([label, value, totals]) => (
            <tr key={label} className="border-t border-line">
              <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left">
                {label}
              </th>
              <td />
              {cols.map((c) => (
                <td key={c.id} className="px-3 py-2 text-right">
                  {label === "Total change" ? <Delta value={value(c.id) ?? 0} /> : <Money value={value(c.id)} kind={c.kind} />}
                </td>
              ))}
              <td />
              <td className="px-3 py-2 text-right">{label === "Total change" ? <Delta value={totals.net} /> : <Money value={totals.net} strong />}</td>
              <td className="px-3 py-2 text-right">{label === "Total change" ? <Delta value={totals.liquid} /> : <Money value={totals.liquid} strong />}</td>
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}

/** Narrow screens: one card per action, with a sticky totals footer. */
function Cards({ data, onOpen }: { data: Payload; onOpen: (id: string) => void }) {
  const r = data.checkin.result;
  const name = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? "?";
  const card = (g: GridRow, anticipated = false) => (
    <li key={g.actionId} id={`m-${g.actionId}`} className="card p-3">
      <button type="button" className="w-full text-left" onClick={() => onOpen(g.actionId)}>
        <span className="flex items-start justify-between gap-2">
          <span className="font-medium">{g.label}</span>
          <span className="text-sm text-muted">{g.date ?? "needs a date"}</span>
        </span>
        <span className="mt-1 flex flex-wrap gap-1">{anticipated ? <Badge>Anticipated</Badge> : rowLabels(g)}</span>
        <ul className="mt-2 space-y-1 text-sm">
          {Object.entries(g.deltas).map(([id, v]) => (
            <li key={id} className="flex justify-between gap-2">
              <span>{name(id)}</span>
              <Delta value={v} />
            </li>
          ))}
        </ul>
        {g.unbalanced ? <span className="mt-1 block text-xs text-danger">Not balanced: {g.unbalanced}</span> : null}
      </button>
    </li>
  );
  return (
    <div>
      <ul className="space-y-2">{r.rows.map((g) => card(g))}</ul>
      {r.ifReceived.length ? (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">If received (not in totals)</h3>
          <ul className="mt-2 space-y-2">{r.ifReceived.map((g) => card(g, true))}</ul>
        </>
      ) : null}
      <div className="safe-bottom sticky bottom-[64px] z-20 mt-3 grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface/95 p-3 text-sm shadow backdrop-blur">
        <div>
          <p className="text-muted">Net position</p>
          <Money value={r.ending.net} strong />
        </div>
        <div>
          <p className="text-muted">Liquid cash</p>
          <Money value={r.ending.liquid} strong />
        </div>
      </div>
    </div>
  );
}

function ReservePanel({ result, settings, data }: { result: CheckinResult; settings: ReserveSettings; data: Payload }) {
  const r = result.reserve;
  const name = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? "?";
  return (
    <Card>
      <h2 className="font-semibold">Reserve</h2>
      <p className="mt-1 text-xs text-muted">
        A restriction on {r.accountId ? name(r.accountId) : "checking"}: money that stays put. It never reduces Net position. Mode:{" "}
        {settings.mode === "additive" ? "cushion + peak" : "the larger of cushion and peak"}, {settings.horizonDays}-day horizon.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted">Cushion</dt>
        <dd className="text-right">
          {r.cushion === null ? (
            <Link href="/finance/funds" className="text-danger underline">
              Set it
            </Link>
          ) : (
            <Money value={r.cushion} />
          )}
        </dd>
        <dt className="text-muted">Peak outflow in horizon</dt>
        <dd className="text-right">
          <Money value={r.peak} />
        </dd>
        <dt className="font-medium">Required reserve</dt>
        <dd className="text-right">
          <Money value={r.required} strong />
        </dd>
        <dt className="text-muted">Checking after planned actions</dt>
        <dd className="text-right">
          <Money value={r.checkingAfter} />
        </dd>
        <dt className="text-muted">Fund earmarks in checking</dt>
        <dd className="text-right">
          <Money value={r.checkingFundHoldings} />
        </dd>
        <dt className="font-medium">Unrestricted checking</dt>
        <dd className="text-right">
          <Money value={r.unrestricted} strong />
        </dd>
      </dl>
      {r.unrestricted !== null && r.unrestricted < 0 ? (
        <p role="alert" className="mt-2 flex items-center gap-1 text-sm text-danger">
          <AlertIcon className="h-4 w-4" /> Unrestricted checking is negative.
        </p>
      ) : null}
      {r.schedule.length ? (
        <>
          <h3 className="mt-3 text-sm font-medium">What the reserve covers</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {r.schedule.map((s) => (
              <li key={s.flowId} className="flex justify-between gap-2">
                <span>
                  {s.date} · {s.label}
                </span>
                <Delta value={s.amount} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="mt-3 text-sm font-medium">Day by day</h3>
      <ul className="mt-1 space-y-1 text-sm">
        {result.liquidity.map((l) => (
          <li key={l.accountId}>
            {name(l.accountId)}: lowest <Money value={l.minBalance} /> {l.minDate ? `on ${l.minDate}` : ""}
            {l.overdraft ? (
              <span className="block text-danger">
                Goes below zero on {l.overdraft.date} (“{l.overdraft.cause}”){l.overdraft.nextInflow ? ` before the ${l.overdraft.nextInflow} inflow` : ""}.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Suggestions({ data, onUse }: { data: Payload; onUse: (d: Draft) => void }) {
  const s = data.checkin.result.suggestions;
  const name = (id?: string) => data.accounts.find((a) => a.id === id)?.name ?? "?";
  const { hidden } = useHideAmounts();
  if (!s.length) return null;
  return (
    <Card>
      <h2 className="font-semibold">Card payments</h2>
      <p className="mt-1 text-xs text-muted">Suggestions only: nothing is added until you choose it. Planned and in-transit payments are already deducted.</p>
      <ul className="mt-3 space-y-3">
        {s.map((x) => (
          <li key={x.accountId} className="rounded-xl border border-line p-3 text-sm">
            <p className="font-medium">{name(x.accountId)}</p>
            <p className="text-muted">
              Basis: {x.basis ?? "not chosen"} · owed <Money value={x.owed} /> · planned/in transit <Money value={x.pending} />
            </p>
            {x.blockedReason ? (
              <p className="mt-1 text-warn">{x.blockedReason}</p>
            ) : x.suggested > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span>
                  Pay <Money value={x.suggested} /> from {x.source.kind === "decision" ? "— needs a decision" : name(x.source.accountId)} on {x.date}
                </span>
                <Button
                  size="sm"
                  onClick={() =>
                    onUse({
                      ...emptyDraft(),
                      kind: x.source.kind === "savings" ? "card_payment" : "card_payment",
                      label: `Pay ${name(x.accountId)}`,
                      amount: hidden ? "" : (x.suggested / 100).toFixed(2),
                      fromAccountId: x.source.accountId ?? "",
                      toAccountId: x.accountId,
                      date: x.date,
                    })
                  }
                >
                  Use this
                </Button>
              </div>
            ) : (
              <p className="mt-1 text-ok">Nothing more to pay.</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Transactions({ data }: { data: Payload }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [choice, setChoice] = useState<Record<string, Inclusion>>({});
  const confirm = useMutation({
    mutationFn: (p: MatchProposal) =>
      api.post(`/api/finance/checkins/${data.checkin.id}/match`, {
        transactionId: p.transactionId,
        actionId: p.actionId,
        side: p.side,
        inclusion: choice[p.transactionId] ?? p.proposedInclusion,
      }),
    onSuccess: () => {
      toast("Matched", "ok");
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const name = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? "?";
  const action = (id: string) => data.checkin.actions.find((a) => a.id === id);
  const txns = data.transactions.slice(0, 40);
  if (!txns.length) return null;
  return (
    <Card>
      <h2 className="font-semibold">Recent transactions</h2>
      <p className="mt-1 text-xs text-muted">
        Matches are suggestions; confirm each one and say whether it’s already in the balance. Pending is never counted as posted.
      </p>
      <ul className="mt-3 divide-y divide-line text-sm">
        {txns.map((t) => {
          const p = data.proposals.find((x) => x.transactionId === t.id);
          return (
            <li key={t.id} className="py-2">
              <div className="flex flex-wrap justify-between gap-2">
                <span>
                  {t.date} · {name(t.accountId)} · {t.description || "—"} {t.pending ? <Badge tone="warn">Pending</Badge> : null}
                  {t.ambiguous ? <Badge tone="warn">Overlaps another source</Badge> : null}
                </span>
                <Delta value={t.amount} />
              </div>
              {t.matched ? (
                <p className="text-muted">Matched to “{action(t.matched.actionId)?.label ?? "an action"}”</p>
              ) : p ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span>
                    Looks like “{action(p.actionId)?.label}” ({p.side === "source" ? "leaving" : "arriving"}). {p.reason}
                  </span>
                  <label className="sr-only" htmlFor={`inc-${t.id}`}>
                    Is it in the balance?
                  </label>
                  <select
                    id={`inc-${t.id}`}
                    className="min-h-11 rounded-lg border border-line-strong bg-surface px-2"
                    value={choice[t.id] ?? p.proposedInclusion}
                    onChange={(e) => setChoice((c) => ({ ...c, [t.id]: e.target.value as Inclusion }))}
                  >
                    <option value="included">Already in the balance</option>
                    <option value="excluded">Not in the balance yet</option>
                    <option value="unknown">Not sure</option>
                  </select>
                  <Button size="sm" busy={confirm.isPending && confirm.variables?.transactionId === t.id} onClick={() => confirm.mutate(p)}>
                    Confirm match
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function CheckinView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["finance", "checkin", id], queryFn: () => api.get<Payload>(`/api/finance/checkins/${id}`) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const snapshot = useMutation({
    mutationFn: () => api.post(`/api/finance/checkins/${id}/snapshot`, { version: q.data!.checkin.version }),
    onSuccess: () => {
      toast("Using the latest balances", "ok");
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const close = useMutation({
    mutationFn: () => api.post(`/api/finance/checkins/${id}/close`, { version: q.data!.checkin.version, note: note || undefined }),
    onSuccess: () => {
      toast("Check-in closed", "ok");
      setClosing(false);
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  const openAction = useMemo(() => q.data?.checkin.actions.find((a) => a.id === open), [q.data, open]);
  if (q.isPending) return <Spinner label="Loading check-in" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const data = q.data;
  const c = data.checkin;
  const r = c.result;
  const editable = c.status === "draft";
  const month = new Date(`${c.month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const status = !editable ? (
    <Badge tone="ok">Closed {c.closedAt ? relativeTime(c.closedAt) : ""}</Badge>
  ) : r.blocking ? (
    <Badge tone="danger">
      <AlertIcon className="h-3.5 w-3.5" /> Needs attention ({r.issues.length})
    </Badge>
  ) : r.canClose ? (
    <Badge tone="ok">
      <CheckIcon className="h-3.5 w-3.5" /> Ready to close
    </Badge>
  ) : (
    <Badge tone="warn">
      Review {r.unacknowledged} warning{r.unacknowledged === 1 ? "" : "s"}
    </Badge>
  );
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title={`${month} check-in`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {status}
            {c.snapshotAt ? <span>Balances snapshot {relativeTime(c.snapshotAt)}</span> : null}
            {c.refreshRunning ? <Badge tone="accent">Refresh running…</Badge> : null}
          </span>
        }
        actions={
          editable ? (
            <>
              <Button onClick={() => setDraft(emptyDraft())}>Add action</Button>
              <Button busy={snapshot.isPending} onClick={() => snapshot.mutate()} title="Use the newest balances">
                Use latest balances
              </Button>
              <Button variant="primary" disabled={!r.canClose} onClick={() => setClosing(true)}>
                Close check-in
              </Button>
            </>
          ) : null
        }
      />
      {!editable && c.closeNote ? <p className="text-sm text-muted">Note: {c.closeNote}</p> : null}
      <IssueList issues={r.issues} checkinId={c.id} acknowledged={c.acknowledged.map((a) => a.key)} editable={editable} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <div className="hidden md:block">
            <Grid data={data} onOpen={setOpen} />
          </div>
          <div className="md:hidden">
            <Cards data={data} onOpen={setOpen} />
          </div>
          {r.inTransit !== 0 ? (
            <p className="text-sm">
              In transit (one side seen, the other not yet): <Delta value={r.inTransit} />. Net position plus in transit equals the position before those moves.
            </p>
          ) : null}
          <p className={cx("text-sm", r.conservation.ok ? "text-muted" : "text-danger")}>
            {r.conservation.ok ? (
              <>
                <CheckIcon className="inline h-4 w-4" /> Totals reconcile: ending net = starting net + remaining external and internal effects.
              </>
            ) : (
              <>Totals don’t reconcile (expected {fmt(r.conservation.expected)}).</>
            )}
          </p>
          {editable ? <Transactions data={data} /> : null}
        </div>
        <div className="space-y-4">
          <ReservePanel result={r} settings={data.settings} data={data} />
          {editable ? <Suggestions data={data} onUse={setDraft} /> : null}
          {r.funds.length ? (
            <Card>
              <h2 className="font-semibold">Funds</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {r.funds.map((f) => (
                  <li key={f.fundId} className="flex justify-between gap-2">
                    <span>
                      {f.name} {f.protected ? <Badge>Protected</Badge> : null}
                    </span>
                    <span>
                      <Money value={f.available} /> {f.reserved ? <span className="text-muted">(after planned)</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
      <ActionDialog draft={draft} onClose={() => setDraft(null)} data={data} />
      <Dialog open={Boolean(openAction)} onClose={() => setOpen(undefined)} title={openAction?.label ?? ""} size="lg">
        {openAction ? (
          <ActionDetails
            action={openAction}
            data={data}
            editable={editable}
            onEdit={() => {
              setDraft(draftFrom(openAction));
              setOpen(undefined);
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        title={`Close the ${month} check-in?`}
        description="A closed check-in can't be edited. Later corrections go into a future check-in as adjustments."
        footer={
          <>
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={close.isPending} onClick={() => close.mutate()}>
              Close it
            </Button>
          </>
        }
      >
        <Field id="close-note" label="Note (optional)">
          <input id="close-note" data-autofocus className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
