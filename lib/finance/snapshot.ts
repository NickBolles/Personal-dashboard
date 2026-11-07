import { isBank, type AccountKind, type Cents } from "./types";

export type FinanceSnapshot = {
  netWorth: Cents | null;
  accounts: number;
  cashFlow: { net: Cents; points: { date: string; value: Cents }[]; transactions: number } | null;
};

type SnapshotAccount = { id: string; kind: AccountKind; archived?: boolean; balance?: { balance: Cents } };
type SnapshotTransaction = { accountId: string; date: string; amount: Cents; pending: boolean; supersededBy?: string | null; ambiguous?: boolean };

/** Observed balances, not planned check-in totals. Cash flow is posted bank movement, not income/spending categorization. */
export function financeSnapshot(accounts: SnapshotAccount[], transactions: SnapshotTransaction[], through: string): FinanceSnapshot {
  const active = accounts.filter((a) => !a.archived);
  const banks = new Set(active.filter((a) => isBank(a.kind)).map((a) => a.id));
  const daily = new Map<string, Cents>();
  let count = 0;
  for (const t of transactions) {
    if (!banks.has(t.accountId) || t.pending || t.supersededBy || t.ambiguous || t.date.slice(0, 7) !== through.slice(0, 7) || t.date > through) continue;
    daily.set(t.date, (daily.get(t.date) ?? 0) + t.amount);
    count++;
  }
  let cumulative = 0;
  const points = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, value: (cumulative += amount) }));
  return {
    netWorth: active.length && active.every((a) => a.balance) ? active.reduce((sum, a) => sum + a.balance!.balance, 0) : null,
    accounts: active.length,
    cashFlow: count ? { net: cumulative, points, transactions: count } : null,
  };
}

/** Small, dependency-free SVG geometry; a flat series stays centered (no divide by zero). */
export function sparklinePoints(values: Cents[], width = 160, height = 36): string {
  if (!values.length) return "";
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return values
    .map(
      (value, i) => `${2 + (i / Math.max(1, values.length - 1)) * (width - 4)},${max === min ? height / 2 : 2 + ((max - value) / (max - min)) * (height - 4)}`,
    )
    .join(" ");
}
