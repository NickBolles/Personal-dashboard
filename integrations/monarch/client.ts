import "server-only";
import { z } from "zod";
import { upstream } from "@/server/http/fetch";
import { UpstreamError } from "@/server/http/errors";
import { resolveIntegration } from "@/integrations/store";

/**
 * Monarch Money (balances + recent transactions) over its web GraphQL API.
 * Monarch publishes no supported API: this is the connector spike from the
 * finance plan. Until a refresh succeeds against your real account it is a
 * release blocker (docs/finance.md), and manual/CSV input is the fallback,
 * never a silent substitute. Upstream DTOs stay in this file.
 *
 * The session token is a server-side secret: never sent to the browser,
 * never logged (upstream() never logs headers).
 */
const SOURCE = "Monarch";

const accountSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    isAsset: z.boolean().nullish(),
    currentBalance: z.number().nullish(),
    displayLastUpdatedAt: z.string().nullish(),
    deactivatedAt: z.string().nullish(),
    isHidden: z.boolean().nullish(),
    type: z.object({ name: z.string() }).nullish(),
    subtype: z.object({ name: z.string() }).nullish(),
    hasSyncInProgress: z.boolean().nullish(),
  })
  .passthrough();
type MonarchAccountDto = z.infer<typeof accountSchema>;

const transactionSchema = z
  .object({
    id: z.string(),
    amount: z.number(),
    pending: z.boolean().nullish(),
    date: z.string(),
    plaidName: z.string().nullish(),
    merchant: z.object({ name: z.string().nullish() }).nullish(),
    account: z.object({ id: z.string() }),
  })
  .passthrough();

function gqlEnvelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({ data: data.nullish(), errors: z.array(z.object({ message: z.string() })).nullish() });
}

export type MonarchConn = { baseUrl: string; token: string };

export function monarchConn(): MonarchConn {
  const r = resolveIntegration("finance");
  if (r.config.balanceSource !== "monarch") throw new UpstreamError(SOURCE, "unsupported", "Monarch isn't selected as the balance source");
  if (!r.secrets.monarchToken) throw new UpstreamError(SOURCE, "unauthorized", "No Monarch session token saved");
  return { baseUrl: r.config.monarchUrl || "https://api.monarchmoney.com", token: r.secrets.monarchToken };
}

async function gql<T extends z.ZodTypeAny>(
  c: MonarchConn,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  data: T,
): Promise<z.infer<T>> {
  const raw = await upstream({
    source: SOURCE,
    baseUrl: c.baseUrl,
    path: "/graphql",
    method: "POST",
    headers: { authorization: `Token ${c.token}`, "client-platform": "web" },
    body: { operationName, query, variables },
    timeoutMs: 15_000,
  });
  const parsed = gqlEnvelope(data).safeParse(raw);
  if (!parsed.success) throw new UpstreamError(SOURCE, "bad_response", `Unexpected ${operationName} response shape`);
  if (parsed.data.errors?.length) throw new UpstreamError(SOURCE, "bad_response", `${operationName}: ${parsed.data.errors[0]!.message.slice(0, 200)}`);
  if (!parsed.data.data) throw new UpstreamError(SOURCE, "bad_response", `${operationName} returned no data`);
  return parsed.data.data;
}

const ACCOUNTS_QUERY = `query GetAccounts {
  accounts { id displayName isAsset currentBalance displayLastUpdatedAt deactivatedAt isHidden hasSyncInProgress type { name } subtype { name } }
}`;

/** Normalized for the finance module: signed cents, provider as-of (or null), no institution or mask. */
export type MonarchAccount = {
  externalId: string;
  name: string;
  type: "checking" | "savings" | "credit_card" | "other_asset" | "other_liability";
  balance: number | null;
  asOf: string | null;
  syncing: boolean;
};

function normalizeAccount(a: MonarchAccountDto): MonarchAccount {
  const t = a.type?.name;
  const sub = a.subtype?.name;
  const type: MonarchAccount["type"] =
    t === "credit"
      ? "credit_card"
      : t === "depository"
        ? sub === "savings"
          ? "savings"
          : "checking"
        : a.isAsset === false
          ? "other_liability"
          : "other_asset";
  // Monarch reports liabilities as positive amounts owed; Jarvis stores them negative. (Verify against a real card: docs/finance.md.)
  const signed = a.currentBalance === null || a.currentBalance === undefined ? null : a.isAsset === false ? -a.currentBalance : a.currentBalance;
  return {
    externalId: a.id,
    name: a.displayName,
    type,
    balance: signed === null ? null : Math.round(signed * 100),
    asOf: a.displayLastUpdatedAt ?? null,
    syncing: Boolean(a.hasSyncInProgress),
  };
}

export async function listAccounts(c = monarchConn()): Promise<MonarchAccount[]> {
  const d = await gql(c, "GetAccounts", ACCOUNTS_QUERY, {}, z.object({ accounts: z.array(accountSchema) }));
  return d.accounts.filter((a) => !a.deactivatedAt).map(normalizeAccount);
}

/** Ask Monarch to sync with the banks, then wait (bounded) until it says it's done. */
export async function refreshAndWait(c: MonarchConn, opts: { waitMs: number; pollMs?: number }) {
  const d = await gql(
    c,
    "Common_ForceRefreshAccountsMutation",
    `mutation Common_ForceRefreshAccountsMutation($input: ForceRefreshAccountsInput!) { forceRefreshAccounts(input: $input) { success errors { message } } }`,
    { input: { accountIds: (await listAccounts(c)).map((a) => a.externalId) } },
    z.object({ forceRefreshAccounts: z.object({ success: z.boolean(), errors: z.array(z.object({ message: z.string() })).nullish() }) }),
  );
  if (!d.forceRefreshAccounts.success) {
    throw new UpstreamError(SOURCE, "bad_response", `Monarch refused the refresh: ${d.forceRefreshAccounts.errors?.[0]?.message ?? "no reason given"}`);
  }
  const until = Date.now() + opts.waitMs;
  for (;;) {
    const accounts = await listAccounts(c);
    const syncing = accounts.filter((a) => a.syncing).length;
    if (!syncing) return { accounts, completed: true };
    if (Date.now() >= until) return { accounts, completed: false, stillSyncing: syncing };
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
  }
}

export type MonarchTransaction = { externalId: string; accountExternalId: string; date: string; amount: number; description: string; pending: boolean };

export async function listTransactions(c: MonarchConn, since: string, limit = 500): Promise<MonarchTransaction[]> {
  const d = await gql(
    c,
    "GetTransactionsList",
    `query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput) {
      allTransactions(filters: $filters) { totalCount results(offset: $offset, limit: $limit) { id amount pending date plaidName merchant { name } account { id } } }
    }`,
    { offset: 0, limit, filters: { startDate: since } },
    z.object({ allTransactions: z.object({ results: z.array(transactionSchema) }) }),
  );
  return d.allTransactions.results.map((t) => ({
    externalId: t.id,
    accountExternalId: t.account.id,
    date: t.date.slice(0, 10),
    amount: Math.round(t.amount * 100),
    description: (t.merchant?.name ?? t.plaidName ?? "").slice(0, 200),
    pending: Boolean(t.pending),
  }));
}
