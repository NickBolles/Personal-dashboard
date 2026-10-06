"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { relativeTime } from "@/lib/time";
import { ACCOUNT_KINDS, type AccountKind } from "@/lib/finance/types";
import type { AccountView } from "@/server/finance/accounts";
import type { FinanceOverview } from "@/server/finance/overview";
import { Badge, Button, Card, ErrorNote, Field, PageHeader, Spinner, inputCls, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { Money, toCents } from "@/components/finance/money";

const KIND_LABEL: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  other_asset: "Other asset",
  other_liability: "Other liability",
};

type External = { source: string; externalId: string; name: string; type: string | null; ignored: boolean; mappedTo: string | null; lastSeenAt: string };
type Run = { id: string; kind: string; status: string; outcome: string | null; error: string | null; startedAt: string; finishedAt: string | null };

function useFinanceMutation<T>(fn: (v: T) => Promise<unknown>, ok?: string) {
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

function AddAccount() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("checking");
  const [basis, setBasis] = useState("");
  const add = useFinanceMutation(
    () =>
      api.post("/api/finance/accounts", {
        name,
        kind,
        cardBasis: kind === "credit_card" ? basis || null : null,
        reserveAccount: kind === "checking" ? undefined : false,
      }),
    "Account added",
  );
  return (
    <form
      className="grid items-end gap-3 sm:grid-cols-[1fr_180px_200px_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined, { onSuccess: () => setName("") });
      }}
    >
      <Field id="na-name" label="Name">
        <input id="na-name" required className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Joint checking" />
      </Field>
      <Field id="na-kind" label="Kind">
        <select id="na-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
          {ACCOUNT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {kind === "credit_card" ? (
        <Field id="na-basis" label="Pay by">
          <select id="na-basis" className={inputCls} value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="">Choose (required to plan)</option>
            <option value="statement">Statement balance</option>
            <option value="current">Current balance</option>
          </select>
        </Field>
      ) : (
        <div />
      )}
      <Button type="submit" variant="primary" busy={add.isPending}>
        Add
      </Button>
    </form>
  );
}

function BalanceEntry({ accounts }: { accounts: AccountView[] }) {
  const [values, setValues] = useState<Record<string, { balance: string; st?: string; paid?: string; due?: string }>>({});
  const [asOf, setAsOf] = useState("");
  const set = (id: string, p: Partial<{ balance: string; st: string; paid: string; due: string }>) =>
    setValues((v) => ({ ...v, [id]: { ...(v[id] ?? { balance: "" }), ...p } }));
  const save = useFinanceMutation(() => {
    const entries = Object.entries(values)
      .filter(([, v]) => v.balance.trim())
      .map(([accountId, v]) => {
        const acct = accounts.find((a) => a.id === accountId)!;
        const balance = toCents(v.balance);
        if (balance === undefined) throw new Error(`${acct.name}: “${v.balance}” isn't an amount`);
        const liability = acct.kind === "credit_card" || acct.kind === "other_liability";
        return {
          accountId,
          // People type what they owe as a positive number; liabilities are stored negative.
          balance: liability ? -Math.abs(balance) : balance,
          asOf: asOf ? new Date(asOf).toISOString() : null,
          ...(v.st || v.paid || v.due
            ? {
                statement: {
                  balance: v.st ? (toCents(v.st) ?? null) : null,
                  paymentsCredited: v.paid ? (toCents(v.paid) ?? null) : null,
                  dueDate: v.due || null,
                },
              }
            : {}),
        };
      });
    if (!entries.length) throw new Error("Enter at least one balance");
    return api.post("/api/finance/balances", { entries });
  }, "Balances saved");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: () => setValues({}) });
      }}
    >
      <Field id="bal-asof" label="True as of" hint="Leave empty if you're reading them right now.">
        <input id="bal-asof" type="datetime-local" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </Field>
      <ul className="space-y-3">
        {accounts.map((a) => (
          <li key={a.id} className="grid items-end gap-2 sm:grid-cols-[1fr_160px]">
            <Field id={`bal-${a.id}`} label={`${a.name}${a.kind === "credit_card" ? " (amount owed)" : ""}`}>
              <input
                id={`bal-${a.id}`}
                inputMode="decimal"
                className={inputCls}
                value={values[a.id]?.balance ?? ""}
                onChange={(e) => set(a.id, { balance: e.target.value })}
              />
            </Field>
            {a.kind === "credit_card" && a.cardBasis === "statement" ? (
              <details className="sm:col-span-2">
                <summary className="min-h-11 cursor-pointer text-sm text-accent">Statement details for {a.name}</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <Field id={`st-${a.id}`} label="Statement balance">
                    <input
                      id={`st-${a.id}`}
                      inputMode="decimal"
                      className={inputCls}
                      value={values[a.id]?.st ?? ""}
                      onChange={(e) => set(a.id, { st: e.target.value })}
                    />
                  </Field>
                  <Field id={`pd-${a.id}`} label="Payments credited to it">
                    <input
                      id={`pd-${a.id}`}
                      inputMode="decimal"
                      className={inputCls}
                      value={values[a.id]?.paid ?? ""}
                      onChange={(e) => set(a.id, { paid: e.target.value })}
                    />
                  </Field>
                  <Field id={`du-${a.id}`} label="Due date">
                    <input
                      id={`du-${a.id}`}
                      type="date"
                      className={inputCls}
                      value={values[a.id]?.due ?? ""}
                      onChange={(e) => set(a.id, { due: e.target.value })}
                    />
                  </Field>
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <Button type="submit" variant="primary" busy={save.isPending}>
        Save balances
      </Button>
    </form>
  );
}

function CsvImport({ accounts }: { accounts: AccountView[] }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<"balances" | "transactions">("balances");
  const [accountId, setAccountId] = useState("");
  const [csv, setCsv] = useState("");
  const run = useFinanceMutation(async () => {
    const r = await api.post<{ imported: number; errors: { line: number; message: string }[]; ambiguous?: number }>("/api/finance/import", {
      kind,
      csv,
      accountId: kind === "transactions" ? accountId : undefined,
    });
    toast(
      `Imported ${r.imported}${r.errors.length ? `, ${r.errors.length} skipped (line ${r.errors[0]!.line}: ${r.errors[0]!.message})` : ""}${r.ambiguous ? `, ${r.ambiguous} overlap another source` : ""}`,
      r.errors.length || r.ambiguous ? "warn" : "ok",
    );
    setCsv("");
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate(undefined);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="csv-kind" label="What's in the file">
          <select id="csv-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="balances">Balances: account,balance,as_of[,statement_balance,payments_credited,due_date]</option>
            <option value="transactions">Transactions: date,amount,description[,pending]</option>
          </select>
        </Field>
        {kind === "transactions" ? (
          <Field id="csv-account" label="Account">
            <select id="csv-account" required className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      <Field id="csv-file" label="CSV file">
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          className={inputCls}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
        />
      </Field>
      <Field id="csv-text" label="…or paste it">
        <textarea id="csv-text" className={`${inputCls} h-28 font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} />
      </Field>
      <Button type="submit" busy={run.isPending} disabled={!csv.trim()}>
        Import
      </Button>
    </form>
  );
}

function AccountRow({ a, external, monarch, editable }: { a: AccountView; external: External[]; monarch: boolean; editable: boolean }) {
  const patch = useFinanceMutation((body: Record<string, unknown>) => api.patch(`/api/finance/accounts/${a.id}`, { ...body, version: a.version }), "Saved");
  const b = a.balance;
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className="px-3 py-2 text-left font-medium">
        {a.name}
        <div className="text-xs font-normal text-muted">{KIND_LABEL[a.kind]}</div>
        {a.reserveAccount ? <Badge tone="accent">Reserve account</Badge> : null}
      </th>
      <td className="px-3 py-2">
        {b ? (
          <>
            <Money value={b.balance} kind={a.kind} />
            <div className="text-xs text-muted">
              {b.source} · {b.asOf ? `as of ${relativeTime(b.asOf)}` : "as-of unknown"} · fetched {relativeTime(b.fetchedAt)}
            </div>
          </>
        ) : (
          <span className="text-muted">No balance yet</span>
        )}
      </td>
      <td className="space-y-2 px-3 py-2">
        {a.kind === "credit_card" ? (
          <label className="block text-sm">
            <span className="sr-only">Pay {a.name} by</span>
            <select
              disabled={!editable}
              className="min-h-11 rounded-lg border border-line-strong bg-surface px-2"
              value={a.cardBasis ?? ""}
              onChange={(e) => patch.mutate({ cardBasis: e.target.value || null })}
            >
              <option value="">Basis not chosen</option>
              <option value="statement">Pay statement balance</option>
              <option value="current">Pay current balance</option>
            </select>
          </label>
        ) : null}
        {a.kind === "checking" && !a.reserveAccount && editable ? (
          <Button size="sm" onClick={() => patch.mutate({ reserveAccount: true })}>
            Make reserve account
          </Button>
        ) : null}
        {monarch ? (
          <label className="block text-sm">
            <span className="sr-only">Monarch record for {a.name}</span>
            <select
              disabled={!editable}
              className="min-h-11 max-w-56 rounded-lg border border-line-strong bg-surface px-2"
              value={a.externalId ?? ""}
              onChange={(e) => patch.mutate({ external: e.target.value ? { source: "monarch", externalId: e.target.value } : null })}
            >
              <option value="">Not linked to Monarch</option>
              {external
                .filter((x) => !x.ignored && (!x.mappedTo || x.mappedTo === a.id))
                .map((x) => (
                  <option key={x.externalId} value={x.externalId}>
                    {x.name} ({x.type ?? "?"})
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {editable ? (
          <Button size="sm" variant="ghost" onClick={() => patch.mutate({ archived: true })}>
            Archive
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export function AccountsView() {
  const { can } = useAccess();
  const editable = can("finance.edit");
  const { toast } = useToast();
  const accounts = useQuery({ queryKey: ["finance", "accounts"], queryFn: () => api.get<{ accounts: AccountView[] }>("/api/finance/accounts") });
  const external = useQuery({ queryKey: ["finance", "external"], queryFn: () => api.get<{ external: External[] }>("/api/finance/external") });
  const runs = useQuery({ queryKey: ["finance", "runs"], queryFn: () => api.get<{ runs: Run[] }>("/api/finance/runs") });
  const overview = useQuery({ queryKey: ["finance", "overview"], queryFn: () => api.get<FinanceOverview>("/api/finance/overview") });
  const monarch = overview.data?.setup.balanceSource === "monarch" || Boolean(external.data?.external.length);
  const refresh = useFinanceMutation(async () => {
    const r = await api.post<{ outcome: string; stored: number; unmapped: number }>("/api/finance/refresh");
    toast(
      `Refreshed ${r.stored} account${r.stored === 1 ? "" : "s"}${r.unmapped ? `; ${r.unmapped} Monarch records not linked` : ""}`,
      r.outcome === "ready" ? "ok" : "warn",
    );
  });
  const ignore = useFinanceMutation((x: External) => api.patch("/api/finance/external", { source: x.source, externalId: x.externalId, ignored: !x.ignored }));
  const list = accounts.data?.accounts ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title="Accounts"
        subtitle="Balances keep their source, as-of and fetch time. Unknown as-of stays unknown."
        actions={
          monarch && editable ? (
            <Button busy={refresh.isPending} onClick={() => refresh.mutate(undefined)}>
              Refresh from Monarch
            </Button>
          ) : null
        }
      />
      {accounts.isPending ? <Spinner label="Loading accounts" /> : null}
      {accounts.error ? <ErrorNote error={accounts.error} /> : null}
      {list.length ? (
        <div data-scroll-x tabIndex={0} role="region" aria-label="Scrollable table" className="card relative overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Accounts and latest balances</caption>
            <thead className="bg-surface-2 text-left">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Account
                </th>
                <th scope="col" className="px-3 py-2">
                  Latest balance
                </th>
                <th scope="col" className="px-3 py-2">
                  Settings
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <AccountRow key={a.id} a={a} external={external.data?.external ?? []} monarch={monarch} editable={editable} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editable ? (
        <Card>
          <h2 className="mb-3 font-semibold">Add an account</h2>
          <AddAccount />
        </Card>
      ) : null}
      {editable && list.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 font-semibold">Enter balances</h2>
            <BalanceEntry accounts={list} />
          </Card>
          <Card>
            <h2 className="mb-3 font-semibold">Import a CSV</h2>
            <CsvImport accounts={list} />
          </Card>
        </div>
      ) : null}
      {external.data?.external.length ? (
        <Card>
          <h2 className="font-semibold">Monarch records</h2>
          <p className="mt-1 text-xs text-muted">Each record can feed one account. If two records are the same card, mark one as a duplicate.</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {external.data.external.map((x) => (
              <li key={x.externalId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {x.name} <span className="text-muted">({x.type ?? "?"})</span>{" "}
                  {x.mappedTo ? (
                    <Badge tone="ok">Linked to {list.find((a) => a.id === x.mappedTo)?.name ?? "an account"}</Badge>
                  ) : x.ignored ? (
                    <Badge>Duplicate</Badge>
                  ) : (
                    <Badge tone="warn">Not linked</Badge>
                  )}
                </span>
                {editable && !x.mappedTo ? (
                  <Button size="sm" variant="ghost" onClick={() => ignore.mutate(x)}>
                    {x.ignored ? "Not a duplicate" : "Mark as duplicate"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {runs.data?.runs.length ? (
        <Card>
          <h2 className="font-semibold">Recent refreshes and imports</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {runs.data.runs.slice(0, 8).map((r) => (
              <li key={r.id}>
                {relativeTime(r.startedAt)} · {r.kind} · {r.status}
                {r.error ? <span className="text-muted"> ({r.error})</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
