"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { AccountSummary, FundSummary, ReserveResult } from "@/lib/finance/engine";
import type { Fund, FundHolding, ReserveSettings } from "@/lib/finance/types";
import type { AccountView } from "@/server/finance/accounts";
import type { FlowRow } from "@/server/finance/funds";
import { ErrorNote, Field, PageHeader, useToast, Pill, Button, Card, KSpinner, Input, Select, Checkbox } from "@/components/ui";
import { useAccess } from "@/components/access";
import { Delta, Money, centsToInput, toCents } from "@/components/finance/money";

type Payload = {
  funds: (Fund & { version: number })[];
  holdings: (FundHolding & { version: number })[];
  flows: FlowRow[];
  accounts: AccountView[];
  settings: ReserveSettings;
  summary: FundSummary[];
  reserve: ReserveResult | null;
  accountSummaries: AccountSummary[];
};

function useSave<T>(fn: (v: T) => Promise<unknown>, ok?: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (ok) toast(ok, "ok");
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
}

function ReserveSettingsForm({ s, editable }: { s: ReserveSettings; editable: boolean }) {
  const [form, setForm] = useState({ mode: s.mode, horizonDays: String(s.horizonDays), cushion: centsToInput(s.cushion), staleHours: String(s.staleHours) });
  useEffect(() => setForm({ mode: s.mode, horizonDays: String(s.horizonDays), cushion: centsToInput(s.cushion), staleHours: String(s.staleHours) }), [s]);
  const save = useSave(() => {
    const cushion = form.cushion.trim() ? toCents(form.cushion) : null;
    if (cushion === undefined) throw new Error("The cushion must be an amount");
    return api.put("/api/finance/settings", { mode: form.mode, horizonDays: Number(form.horizonDays), cushion, staleHours: Number(form.staleHours) });
  }, "Reserve settings saved");
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined);
      }}
    >
      <Field id="rs-cushion" label="Checking cushion" hint="Always kept in checking. No default: you choose it.">
        <Input id="rs-cushion" disabled={!editable} inputMode="decimal" value={form.cushion} onChange={(e) => setForm({ ...form, cushion: e.target.value })} />
      </Field>
      <Field id="rs-mode" label="How the reserve is sized">
        <Select id="rs-mode" disabled={!editable} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as ReserveSettings["mode"] })}>
          <option value="additive">Cushion + peak outflow</option>
          <option value="max">Larger of cushion and peak outflow</option>
        </Select>
      </Field>
      <Field id="rs-horizon" label="Look ahead (days)">
        <Input
          id="rs-horizon"
          disabled={!editable}
          type="number"
          min={7}
          max={120}
          value={form.horizonDays}
          onChange={(e) => setForm({ ...form, horizonDays: e.target.value })}
        />
      </Field>
      <Field id="rs-stale" label="Balances are stale after (hours)">
        <Input
          id="rs-stale"
          disabled={!editable}
          type="number"
          min={1}
          value={form.staleHours}
          onChange={(e) => setForm({ ...form, staleHours: e.target.value })}
        />
      </Field>
      {editable ? (
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function HoldingInput({
  fund,
  account,
  holding,
  editable,
}: {
  fund: Fund;
  account: AccountView;
  holding?: FundHolding & { version: number };
  editable: boolean;
}) {
  const [v, setV] = useState(centsToInput(holding?.amount ?? 0));
  useEffect(() => setV(centsToInput(holding?.amount ?? 0)), [holding?.amount]);
  const save = useSave(() => {
    const amount = toCents(v || "0");
    if (amount === undefined) throw new Error("Not an amount");
    return api.put(`/api/finance/funds/${fund.id}/holdings`, { accountId: account.id, amount, version: holding?.version ?? null });
  }, `${fund.name} earmark saved`);
  return (
    <Input
      aria-label={`${fund.name} earmarked in ${account.name}`}
      disabled={!editable}
      inputMode="decimal"
      className="w-28 [&_input]:text-right [&_input]:tabular-nums"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== centsToInput(holding?.amount ?? 0) && save.mutate(undefined)}
    />
  );
}

function AddFlow({ accounts, funds }: { accounts: AccountView[]; funds: Fund[] }) {
  const [f, setF] = useState({
    label: "",
    accountId: accounts.find((a) => a.reserveAccount)?.id ?? "",
    type: "bill",
    amount: "",
    date: "",
    recurrence: "monthly",
    reliable: true,
    fundId: "",
  });
  const save = useSave(() => {
    const amount = toCents(f.amount);
    if (amount === undefined) throw new Error("Enter an amount");
    return api.post("/api/finance/flows", {
      label: f.label,
      accountId: f.accountId,
      amount: f.type === "bill" ? -Math.abs(amount) : Math.abs(amount),
      date: f.date,
      recurrence: f.recurrence,
      reliable: f.type === "paycheck" && f.reliable,
      fundId: f.type === "bill" ? f.fundId || null : null,
    });
  }, "Added to the schedule");
  return (
    <form
      className="grid items-end gap-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: () => setF({ ...f, label: "", amount: "" }) });
      }}
    >
      <Field id="fl-type" label="Type">
        <Select id="fl-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="bill">Bill (outflow)</option>
          <option value="paycheck">Paycheck or inflow</option>
        </Select>
      </Field>
      <Field id="fl-label" label="Label">
        <Input id="fl-label" required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
      </Field>
      <Field id="fl-amount" label="Amount">
        <Input id="fl-amount" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
      </Field>
      <Field id="fl-account" label="Account">
        <Select id="fl-account" required value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
          <option value="">Choose…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="fl-date" label="Next date">
        <Input id="fl-date" required type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
      </Field>
      <Field id="fl-rec" label="Repeats">
        <Select id="fl-rec" value={f.recurrence} onChange={(e) => setF({ ...f, recurrence: e.target.value })}>
          <option value="none">Once</option>
          <option value="weekly">Weekly</option>
          <option value="biweekly">Every two weeks</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </Select>
      </Field>
      {f.type === "paycheck" ? (
        <Checkbox checked={f.reliable} onChange={(reliable) => setF({ ...f, reliable })} label="Reliable (a regular paycheck: counts before it posts)" />
      ) : (
        <Field id="fl-fund" label="Paid by a fund?" hint="Funded bills aren't in the reserve.">
          <Select id="fl-fund" value={f.fundId} onChange={(e) => setF({ ...f, fundId: e.target.value })}>
            <option value="">No: the reserve covers it</option>
            {funds.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Button type="submit" loading={save.isPending}>
        Add
      </Button>
    </form>
  );
}

export function FundsView() {
  const { can } = useAccess();
  const editable = can("finance.edit");
  const q = useQuery({ queryKey: ["finance", "funds"], queryFn: () => api.get<Payload>("/api/finance/funds") });
  const [name, setName] = useState("");
  const addFund = useSave(() => api.post("/api/finance/funds", { name }), "Fund added");
  const patchFund = useSave((v: { id: string; version: number; body: Record<string, unknown> }) =>
    api.patch(`/api/finance/funds/${v.id}`, { ...v.body, version: v.version }),
  );
  const delFlow = useSave((id: string) => api.del(`/api/finance/flows/${id}`), "Removed");
  if (q.isPending)
    return (
      <span role="status" className="inline-flex items-center gap-2">
        <KSpinner />
        <span>Loading funds</span>
      </span>
    );
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const banks = d.accounts.filter((a) => a.kind === "checking" || a.kind === "savings");
  const funds = d.funds.filter((f) => !f.archived);
  const name_ = (id: string) => d.accounts.find((a) => a.id === id)?.name ?? "?";
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader title="Funds & reserve" subtitle="Funds are earmarks inside real accounts. They never move money or change balances." />
      <Card>
        <h2 className="font-semibold">Purpose funds</h2>
        {funds.length ? (
          <div data-scroll-x tabIndex={0} role="region" aria-label="Scrollable table" className="mt-3 relative overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Fund earmarks by account</caption>
              <thead className="text-left">
                <tr>
                  <th scope="col" className="px-2 py-2">
                    Fund
                  </th>
                  {banks.map((a) => (
                    <th key={a.id} scope="col" className="px-2 py-2 text-right">
                      {a.name}
                    </th>
                  ))}
                  <th scope="col" className="px-2 py-2 text-right">
                    Available after planned
                  </th>
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Settings</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {funds.map((f) => {
                  const s = d.summary.find((x) => x.fundId === f.id);
                  return (
                    <tr key={f.id} className="border-t border-line">
                      <th scope="row" className="px-2 py-2 text-left font-medium">
                        {f.name} {f.protected ? <Pill>Protected</Pill> : null}
                      </th>
                      {banks.map((a) => (
                        <td key={a.id} className="px-2 py-2 text-right">
                          <HoldingInput fund={f} account={a} holding={d.holdings.find((h) => h.fundId === f.id && h.accountId === a.id)} editable={editable} />
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right">{s ? <Money value={s.available} /> : "—"}</td>
                      <td className="px-2 py-2">
                        {editable ? (
                          <Checkbox
                            checked={f.protected}
                            onChange={(protected_) => patchFund.mutate({ id: f.id, version: f.version, body: { protected: protected_ } })}
                            label="Protected"
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong">
                  <th scope="row" className="px-2 py-2 text-left">
                    Not earmarked
                  </th>
                  {banks.map((a) => {
                    const s = d.accountSummaries.find((x) => x.accountId === a.id);
                    return (
                      <td key={a.id} className="px-2 py-2 text-right">
                        <Money value={s?.unassigned ?? null} />
                        {s && s.end !== null && s.restricted > s.end ? <span className="block text-xs text-danger">Earmarks exceed the balance</span> : null}
                      </td>
                    );
                  })}
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No funds yet. Typical ones: Car, Insurance, Travel, Home, Giving, Emergency, Tax.</p>
        )}
        {editable ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addFund.mutate(undefined, { onSuccess: () => setName("") });
            }}
          >
            <Field id="nf-name" label="New fund">
              <Input id="nf-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button type="submit" loading={addFund.isPending}>
              Add fund
            </Button>
          </form>
        ) : null}
        <p className="mt-2 text-xs text-muted">Protected funds can only be used by an action with an explicit decision recorded on it.</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Reserve</h2>
          <ReserveSettingsForm s={d.settings} editable={editable} />
          {d.reserve ? (
            <p className="mt-3 text-sm">
              This month: required <Money value={d.reserve.required} />, unrestricted checking <Money value={d.reserve.unrestricted} />.
            </p>
          ) : null}
        </Card>
        <Card>
          <h2 className="font-semibold">Scheduled bills and paychecks</h2>
          <p className="mt-1 text-xs text-muted">
            The reserve covers unfunded bills in the look-ahead; reliable paychecks offset them. Every item also feeds the day-by-day cash check.
          </p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {d.flows.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {f.label} · {name_(f.accountId)} · {f.recurrence === "none" ? f.date : `${f.recurrence} from ${f.date}`}
                  {f.reliable ? <Pill tone="ok">Reliable</Pill> : null}
                  {f.fundId ? <Pill>Funded: {d.funds.find((x) => x.id === f.fundId)?.name}</Pill> : null}
                </span>
                <span className="flex items-center gap-2">
                  <Delta value={f.amount} />
                  {editable ? (
                    <Button size="sm" variant="ghost" onClick={() => delFlow.mutate(f.id)}>
                      Remove
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {editable && d.accounts.length ? (
            <div className="mt-3 border-t border-line pt-3">
              <AddFlow accounts={d.accounts} funds={funds} />
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
