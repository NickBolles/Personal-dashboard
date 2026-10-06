// Mock Monarch Money GraphQL (the subset the finance connector uses).
// Liabilities report positive "owed" balances, like Monarch. Synthetic data only.
import { json, readBody } from "./util.mjs";

export function createMonarch({ token }) {
  const state = { refreshes: 0, syncingUntil: 0, accounts: [], transactions: [] };
  function reset() {
    const asOf = new Date(Date.now() - 2 * 3600_000).toISOString();
    state.refreshes = 0;
    state.syncingUntil = 0;
    state.accounts = [
      {
        id: "m-chk",
        displayName: "Joint Checking",
        isAsset: true,
        currentBalance: 10000,
        type: { name: "depository" },
        subtype: { name: "checking" },
        displayLastUpdatedAt: asOf,
      },
      {
        id: "m-sav",
        displayName: "High Yield Savings",
        isAsset: true,
        currentBalance: 48500,
        type: { name: "depository" },
        subtype: { name: "savings" },
        displayLastUpdatedAt: asOf,
      },
      {
        id: "m-visa",
        displayName: "Visa Signature",
        isAsset: false,
        currentBalance: 1500,
        type: { name: "credit" },
        subtype: { name: "credit_card" },
        displayLastUpdatedAt: asOf,
      },
      // Two records for one store card, as seen in the real account list: needs manual resolution.
      {
        id: "m-store-1",
        displayName: "Store Card",
        isAsset: false,
        currentBalance: 120,
        type: { name: "credit" },
        subtype: { name: "credit_card" },
        displayLastUpdatedAt: asOf,
      },
      {
        id: "m-store-2",
        displayName: "Store Card",
        isAsset: false,
        currentBalance: 120,
        type: { name: "credit" },
        subtype: { name: "credit_card" },
        displayLastUpdatedAt: null,
      },
    ];
    const d = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    state.transactions = [
      { id: "t-1", amount: -1500, pending: false, date: d(2), plaidName: "VISA PAYMENT", merchant: null, account: { id: "m-chk" } },
      { id: "t-2", amount: 1500, pending: false, date: d(1), plaidName: "PAYMENT THANK YOU", merchant: null, account: { id: "m-visa" } },
      { id: "t-3", amount: -64.12, pending: true, date: d(0), plaidName: "GROCERY", merchant: { name: "Grocery" }, account: { id: "m-visa" } },
    ];
  }
  reset();
  async function handle(req, res, path, url, control) {
    if (control.fail.has("monarch")) return json(res, 503, { error: "unavailable" });
    if (req.headers.authorization !== `Token ${token}`) return json(res, 401, { detail: "Invalid token." });
    if (path !== "/graphql" || req.method !== "POST") return json(res, 404, { error: "not found" });
    const body = await readBody(req);
    const syncing = Date.now() < state.syncingUntil;
    switch (body.operationName) {
      case "GetAccounts":
        return json(res, 200, { data: { accounts: state.accounts.map((a) => ({ ...a, hasSyncInProgress: syncing, deactivatedAt: null, isHidden: false })) } });
      case "Common_ForceRefreshAccountsMutation":
        state.refreshes++;
        state.syncingUntil = Date.now() + 200;
        for (const a of state.accounts) if (a.displayLastUpdatedAt) a.displayLastUpdatedAt = new Date().toISOString();
        return json(res, 200, { data: { forceRefreshAccounts: { success: true, errors: [] } } });
      case "GetTransactionsList":
        return json(res, 200, { data: { allTransactions: { totalCount: state.transactions.length, results: state.transactions } } });
      default:
        return json(res, 200, { errors: [{ message: `Unknown operation ${body.operationName}` }] });
    }
  }
  return { handle, reset, state };
}
