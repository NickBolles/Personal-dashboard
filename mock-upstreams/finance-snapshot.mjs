// Read-only finance visual seed (#57). Synthetic cents; no AI or live upstream access.
import { isoDateIn } from "./util.mjs";

export function financeSnapshotFixture() {
  const now = new Date("2026-10-15T17:00:00.000Z");
  const date = (offset) => isoDateIn(offset, now);
  /** @type {{ id: string, kind: import('../lib/finance/types').AccountKind, balance: { balance: number } }[]} */
  const accounts = [
    { id: "snapshot-checking", kind: "checking", balance: { balance: 1000000 } },
    { id: "snapshot-savings", kind: "savings", balance: { balance: 4850000 } },
    { id: "snapshot-card", kind: "credit_card", balance: { balance: -150000 } },
  ];
  const transactions = [
    { accountId: accounts[0].id, date: date(-10), amount: 450000, pending: false },
    { accountId: accounts[0].id, date: date(-8), amount: -180000, pending: false },
    { accountId: accounts[0].id, date: date(-5), amount: -6400, pending: false },
    { accountId: accounts[0].id, date: date(-3), amount: 125000, pending: false },
    { accountId: accounts[0].id, date: date(-1), amount: -42000, pending: false },
  ];
  return {
    now: now.toISOString(),
    accounts,
    transactions,
    overview: {
      month: date(0).slice(0, 7),
      status: "ready",
      statusText: "October check-in is ready to review.",
      asOf: now.toISOString(),
      setup: { accounts: 3, cushionSet: true, balanceSource: "manual", monarchValidatedAt: null, releaseBlocker: false },
      snapshot: {
        netWorth: 5700000,
        accounts: 3,
        cashFlow: {
          net: 346600,
          transactions: 5,
          points: [
            { date: date(-10), value: 450000 },
            { date: date(-8), value: 270000 },
            { date: date(-5), value: 263600 },
            { date: date(-3), value: 388600 },
            { date: date(-1), value: 346600 },
          ],
        },
      },
      checkin: { id: "fci_snapshot", month: date(0).slice(0, 7), status: "draft", blocking: 0, warnings: 0, open: 0, canClose: true },
      totals: { net: 5700000, liquid: 5850000, reserve: 200000, unrestricted: 800000, inTransit: 0 },
      funds: [],
      upcoming: [],
      issues: [],
      lastRun: null,
    },
  };
}
