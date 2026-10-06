/**
 * Monthly check-in arithmetic. Pure functions: the server feeds them stored
 * facts, the tests feed them synthetic households. Nothing here moves money.
 *
 * Key rules (docs/finance.md):
 *  - A leg already included in the snapshot contributes no further delta; that
 *    is a fact separate from the action's status.
 *  - Net position = all accounts; Liquid cash = banks only. Both always shown.
 *  - The reserve is a restriction on checking, never a subtraction from totals.
 *  - Funds and the reserve cover disjoint obligations.
 *  - Daily simulation, outflows first on the same day; overdrafts block.
 */
import {
  INTERNAL_KINDS,
  isBank,
  issueKey,
  type ActionLeg,
  type BalanceSnapshot,
  type CardBasis,
  type Cents,
  type FinAccount,
  type FinAction,
  type Fund,
  type FundHolding,
  type Issue,
  type LegSide,
  type ReserveSettings,
  type ScheduledFlow,
} from "./types";

export type CheckinInput = {
  /** YYYY-MM-DD, household timezone */
  today: string;
  /** ISO instant, for staleness */
  now: string;
  accounts: FinAccount[];
  balances: BalanceSnapshot[];
  actions: FinAction[];
  funds: Fund[];
  /** current earmarks, already net of persisted consumption */
  holdings: FundHolding[];
  /** actions whose fund consumption is already persisted (so never counted twice) */
  consumedActionIds?: string[];
  flows: ScheduledFlow[];
  settings: ReserveSettings;
  refreshRunning?: boolean;
  unmatchedTransactions?: number;
  /** warnings someone acknowledged (issueKey) */
  acknowledged?: string[];
};

export type LegEffect = { accountId: string; side: LegSide; delta: Cents; remaining: Cents; inclusion: ActionLeg["inclusion"] };

export type GridRow = {
  actionId: string;
  label: string;
  kind: FinAction["kind"];
  status: FinAction["status"];
  date: string | null;
  external: boolean;
  /** remaining (not yet in the snapshot) effect per account */
  deltas: Record<string, Cents>;
  rowNet: Cents;
  /** one leg already in the snapshot, the other not: the in-transit bridge */
  inTransit: boolean;
  unknown: boolean;
  unbalanced?: string;
  runningNet: Cents;
  runningLiquid: Cents;
  legs: LegEffect[];
};

export type Totals = { net: Cents; liquid: Cents };

export type ReserveEntry = { flowId: string; label: string; date: string; amount: Cents; cumulative: Cents };

export type ReserveResult = {
  accountId?: string;
  cushion: Cents | null;
  peak: Cents;
  required: Cents | null;
  schedule: ReserveEntry[];
  checkingAfter: Cents | null;
  /** unconsumed fund earmarks held in checking */
  checkingFundHoldings: Cents;
  unrestricted: Cents | null;
};

export type LiquidityResult = {
  accountId: string;
  minBalance: Cents;
  minDate: string;
  overdraft?: { date: string; cause: string; nextInflow?: string };
};

export type FundSummary = {
  fundId: string;
  name: string;
  protected: boolean;
  held: Cents;
  reserved: Cents;
  available: Cents;
  byAccount: { accountId: string; held: Cents; reserved: Cents }[];
};

export type AccountSummary = {
  accountId: string;
  start: Cents | null;
  change: Cents;
  end: Cents | null;
  /** fund earmarks (unconsumed) in this account */
  restricted: Cents;
  /** banks: ending balance not earmarked by any fund */
  unassigned: Cents | null;
};

export type CardSuggestion = {
  accountId: string;
  basis: CardBasis | null;
  owed: Cents | null;
  /** planned or in-transit payments not yet reflected in the card snapshot */
  pending: Cents;
  suggested: Cents;
  date: string;
  source: { kind: "checking" | "savings" | "decision"; accountId?: string };
  blockedReason?: string;
};

export type CheckinResult = {
  rows: GridRow[];
  ifReceived: GridRow[];
  accounts: AccountSummary[];
  starting: Totals;
  change: Totals;
  ending: Totals;
  /** sum of one-sided internal legs still to land */
  inTransit: Cents;
  conservation: { ok: boolean; expected: Cents; actual: Cents };
  reserve: ReserveResult;
  liquidity: LiquidityResult[];
  funds: FundSummary[];
  suggestions: CardSuggestion[];
  issues: Issue[];
  blocking: number;
  unacknowledged: number;
  canClose: boolean;
};

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function fmtCents(c: Cents) {
  const sign = c < 0 ? "-" : "";
  return `${sign}${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const active = (a: FinAction) => a.status !== "skipped" && a.status !== "cancelled";

/** The legs an action has, with their full effect on each account. */
export function legEffects(a: FinAction): LegEffect[] {
  const leg = (side: LegSide, accountId: string | null | undefined, delta: Cents): LegEffect[] => {
    if (!accountId) return [];
    const stored = a.legs.find((l) => l.side === side);
    const inclusion = stored?.inclusion ?? "excluded";
    return [{ accountId, side, delta, inclusion, remaining: inclusion === "included" ? 0 : delta }];
  };
  switch (a.kind) {
    case "transfer":
    case "card_payment":
      return [...leg("source", a.fromAccountId, -a.amount), ...leg("destination", a.toAccountId, a.amount)];
    case "external_outflow":
      return leg("source", a.fromAccountId, -a.amount);
    case "external_inflow":
    case "anticipated_refund":
    case "adjustment":
      return leg("destination", a.toAccountId, a.amount);
  }
}

function rowProblem(a: FinAction, accounts: Map<string, FinAccount>): string | undefined {
  if (!Number.isInteger(a.amount)) return "Amount must be whole cents.";
  if (a.kind !== "adjustment" && a.amount <= 0) return "Amount must be more than zero.";
  if (INTERNAL_KINDS.includes(a.kind)) {
    if (!a.fromAccountId || !a.toAccountId) return "Needs both a from and a to account.";
    if (a.fromAccountId === a.toAccountId) return "From and to are the same account.";
    if (a.kind === "card_payment" && accounts.get(a.toAccountId)?.kind !== "credit_card") return "A card payment must go to a card.";
    if (a.kind === "card_payment" && !isBank(accounts.get(a.fromAccountId)?.kind ?? "other_asset")) return "Pay cards from a bank account.";
    return undefined;
  }
  const one = a.kind === "external_outflow" ? a.fromAccountId : a.toAccountId;
  if (!one) return "Pick the account it affects.";
  return undefined;
}

function sortActions(list: FinAction[]) {
  return [...list].sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Which holdings a fund draw comes out of: the pay-from account first (if the
 * fund is held there), then the largest other holdings. Purpose and pay-from
 * account are independent: paying from checking still draws Travel in savings.
 */
export function allocateFundDraw(fundId: string, amount: Cents, payFromAccountId: string | null | undefined, holdings: FundHolding[]) {
  const mine = holdings.filter((h) => h.fundId === fundId && h.amount > 0);
  mine.sort((a, b) => (a.accountId === payFromAccountId ? -1 : b.accountId === payFromAccountId ? 1 : b.amount - a.amount));
  const out: { accountId: string; amount: Cents }[] = [];
  let left = amount;
  for (const h of mine) {
    if (left <= 0) break;
    const take = Math.min(h.amount, left);
    out.push({ accountId: h.accountId, amount: take });
    left -= take;
  }
  return { draws: out, shortfall: Math.max(0, left) };
}

/** Peak cumulative net outflow over the horizon; reserve = cushion + peak (additive) or max(cushion, peak). */
export function computeReserve(
  flows: ScheduledFlow[],
  settings: ReserveSettings,
  accountId: string | undefined,
  today: string,
  coveredFlowIds: Set<string>,
): Pick<ReserveResult, "cushion" | "peak" | "required" | "schedule"> {
  const end = addDays(today, settings.horizonDays);
  const entries = flows
    .filter((f) => f.accountId === accountId && f.date >= today && f.date <= end)
    .filter((f) => (f.amount < 0 ? !coveredFlowIds.has(f.id) && !f.fundId : Boolean(f.reliable)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  let cum = 0;
  let peak = 0;
  const schedule = entries.map((f) => {
    cum += f.amount;
    peak = Math.max(peak, -cum);
    return { flowId: f.id, label: f.label, date: f.date, amount: f.amount, cumulative: cum };
  });
  const required = settings.cushion === null ? null : settings.mode === "additive" ? settings.cushion + peak : Math.max(settings.cushion, peak);
  return { cushion: settings.cushion, peak, required, schedule };
}

type Movement = { date: string; amount: Cents; label: string };

/** Day-by-day balance; outflows before inflows when same-day order is unknown. */
export function simulateAccount(start: Cents, movements: Movement[]): Omit<LiquidityResult, "accountId"> & { firstDate: string } {
  const sorted = [...movements].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  let bal = start;
  let min = start;
  let minDate = sorted[0]?.date ?? "";
  let overdraft: LiquidityResult["overdraft"];
  sorted.forEach((m, i) => {
    bal += m.amount;
    if (bal < min) {
      min = bal;
      minDate = m.date;
    }
    if (bal < 0 && !overdraft) {
      overdraft = { date: m.date, cause: m.label, nextInflow: sorted.slice(i + 1).find((x) => x.amount > 0)?.date };
    }
  });
  return { minBalance: min, minDate, overdraft, firstDate: sorted[0]?.date ?? "" };
}

export function computeCheckin(input: CheckinInput): CheckinResult {
  const accounts = input.accounts.filter((a) => !a.archived);
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const balance = new Map(input.balances.map((b) => [b.accountId, b]));
  const issues: Issue[] = [];
  const issue = (i: Issue) => issues.push(i);
  const label = (id: string | null | undefined) => (id ? (byId.get(id)?.name ?? "an unknown account") : "?");

  const live = sortActions(input.actions.filter(active));
  const confirmed = live.filter((a) => a.kind !== "anticipated_refund");
  const anticipated = live.filter((a) => a.kind === "anticipated_refund");

  // --- starting balances
  const start = new Map<string, Cents>();
  for (const a of accounts) {
    const b = balance.get(a.id);
    if (b) start.set(a.id, b.balance);
  }
  const used = new Set(live.flatMap((a) => legEffects(a).map((l) => l.accountId)));
  for (const id of used) {
    if (!start.has(id)) issue({ code: "balance_missing", blocking: true, message: `No balance for ${label(id)} yet. Refresh or enter it.`, ref: id });
  }
  const totalsOf = (m: Map<string, Cents>): Totals => {
    let net = 0;
    let liquid = 0;
    for (const a of accounts) {
      const v = m.get(a.id);
      if (v === undefined) continue;
      net += v;
      if (isBank(a.kind)) liquid += v;
    }
    return { net, liquid };
  };
  const starting = totalsOf(start);

  // --- rows
  let runNet = starting.net;
  let runLiquid = starting.liquid;
  let externalEffects = 0;
  let internalEffects = 0;
  const change = new Map<string, Cents>();
  const toRow = (a: FinAction, counted: boolean): GridRow => {
    const legs = legEffects(a);
    const deltas: Record<string, Cents> = {};
    for (const l of legs) deltas[l.accountId] = (deltas[l.accountId] ?? 0) + l.remaining;
    const rowNet = legs.reduce((s, l) => s + l.remaining, 0);
    const external = !INTERNAL_KINDS.includes(a.kind);
    const unbalanced = rowProblem(a, byId);
    const unknown = legs.some((l) => l.inclusion === "unknown");
    if (counted) {
      for (const l of legs) {
        if (external) externalEffects += l.remaining;
        else internalEffects += l.remaining;
        if (!start.has(l.accountId) || !accounts.some((x) => x.id === l.accountId)) continue;
        change.set(l.accountId, (change.get(l.accountId) ?? 0) + l.remaining);
        runNet += l.remaining;
        if (isBank(byId.get(l.accountId)!.kind)) runLiquid += l.remaining;
      }
    }
    return {
      actionId: a.id,
      label: a.label,
      kind: a.kind,
      status: a.status,
      date: a.date ?? null,
      external,
      deltas,
      rowNet,
      inTransit: !external && legs.some((l) => l.inclusion === "included") && legs.some((l) => l.inclusion !== "included"),
      unknown,
      unbalanced,
      runningNet: runNet,
      runningLiquid: runLiquid,
      legs,
    };
  };
  const rows = confirmed.map((a) => toRow(a, true));
  const ifReceived = anticipated.map((a) => toRow(a, false));

  for (const r of [...rows, ...ifReceived]) {
    if (r.unbalanced) issue({ code: "row_unbalanced", blocking: true, message: `“${r.label}”: ${r.unbalanced}`, ref: r.actionId });
    if (r.unknown) {
      issue({
        code: "inclusion_unknown",
        blocking: true,
        message: `“${r.label}”: confirm whether it's already in the balance snapshot.`,
        ref: r.actionId,
      });
    }
    if (!r.date) issue({ code: "date_missing", blocking: true, message: `“${r.label}” needs a date.`, ref: r.actionId });
  }

  // --- per-account and totals
  const endMap = new Map<string, Cents>();
  for (const [id, v] of start) endMap.set(id, v + (change.get(id) ?? 0));
  const ending = totalsOf(endMap);
  const changeTotals = { net: ending.net - starting.net, liquid: ending.liquid - starting.liquid };
  const expected = starting.net + externalEffects + internalEffects;
  const conservation = { ok: expected === ending.net, expected, actual: ending.net };
  if (!conservation.ok) {
    issue({
      code: "conservation",
      blocking: true,
      message: `Totals don't reconcile: ending net position should be ${fmtCents(expected)} but the accounts add up to ${fmtCents(ending.net)}.`,
    });
  }
  const inTransit = rows.filter((r) => !r.external).reduce((s, r) => s + r.rowNet, 0);

  // --- funds
  const consumed = new Set(input.consumedActionIds ?? []);
  const reservations = new Map<string, Cents>(); // `${fund}|${account}` -> reserved
  const reservedByFund = new Map<string, Cents>();
  const fundById = new Map(input.funds.map((f) => [f.id, f]));
  for (const a of live) {
    if (!a.fundId || consumed.has(a.id)) continue;
    const f = fundById.get(a.fundId);
    if (!f) continue;
    if (f.protected && !a.fundDecision) {
      issue({
        code: "fund_unauthorized",
        blocking: true,
        message: `“${a.label}” uses the protected ${f.name} fund. Confirm that decision on the action first.`,
        ref: a.id,
      });
    }
    const draw = Math.abs(a.amount);
    const { draws, shortfall } = allocateFundDraw(
      a.fundId,
      draw,
      a.fromAccountId,
      input.holdings.map((h) => ({ ...h, amount: h.amount - (reservations.get(`${h.fundId}|${h.accountId}`) ?? 0) })),
    );
    for (const d of draws) reservations.set(`${a.fundId}|${d.accountId}`, (reservations.get(`${a.fundId}|${d.accountId}`) ?? 0) + d.amount);
    reservedByFund.set(a.fundId, (reservedByFund.get(a.fundId) ?? 0) + draw);
    if (shortfall > 0) {
      issue({
        code: "fund_overdrawn",
        blocking: true,
        message: `“${a.label}” needs more than the ${f.name} fund holds (short ${fmtCents(shortfall)}).`,
        ref: a.id,
      });
    }
  }
  const funds: FundSummary[] = input.funds
    .filter((f) => !f.archived)
    .map((f) => {
      const hs = input.holdings.filter((h) => h.fundId === f.id);
      const byAccount = hs.map((h) => ({ accountId: h.accountId, held: h.amount, reserved: reservations.get(`${f.id}|${h.accountId}`) ?? 0 }));
      const held = hs.reduce((s, h) => s + h.amount, 0);
      const reserved = reservedByFund.get(f.id) ?? 0;
      return { fundId: f.id, name: f.name, protected: f.protected, held, reserved, available: held - reserved, byAccount };
    });
  const restrictedIn = (accountId: string) =>
    input.holdings.filter((h) => h.accountId === accountId).reduce((s, h) => s + h.amount - (reservations.get(`${h.fundId}|${h.accountId}`) ?? 0), 0);

  const accountSummaries: AccountSummary[] = accounts.map((a) => {
    const s = start.get(a.id) ?? null;
    const e = endMap.get(a.id) ?? null;
    const restricted = restrictedIn(a.id);
    return { accountId: a.id, start: s, change: change.get(a.id) ?? 0, end: e, restricted, unassigned: isBank(a.kind) && e !== null ? e - restricted : null };
  });
  for (const s of accountSummaries) {
    if (s.restricted > 0 && s.end !== null && s.restricted > s.end) {
      issue({
        code: "fund_overallocated",
        blocking: false,
        message: `Funds earmark more than ${label(s.accountId)} will hold (${fmtCents(s.restricted)} earmarked, ${fmtCents(s.end)} balance).`,
        ref: s.accountId,
      });
    }
  }

  // --- reserve
  const reserveAccount = accounts.find((a) => a.reserveAccount) ?? accounts.find((a) => a.kind === "checking");
  const coveredFlowIds = new Set(live.map((a) => a.flowId).filter(Boolean) as string[]);
  const r = computeReserve(input.flows, input.settings, reserveAccount?.id, input.today, coveredFlowIds);
  const checkingAfter = reserveAccount ? (endMap.get(reserveAccount.id) ?? null) : null;
  const checkingFundHoldings = reserveAccount ? restrictedIn(reserveAccount.id) : 0;
  const unrestricted = checkingAfter !== null && r.required !== null ? checkingAfter - r.required - checkingFundHoldings : null;
  const reserve: ReserveResult = { accountId: reserveAccount?.id, ...r, checkingAfter, checkingFundHoldings, unrestricted };
  if (reserveAccount && input.settings.cushion === null) {
    issue({ code: "cushion_missing", blocking: true, message: "Set the checking cushion (Finance → Funds & reserve) so the reserve can be calculated." });
  }
  if (unrestricted !== null && unrestricted < 0) {
    issue({
      code: "unrestricted_negative",
      blocking: false,
      message: `Unrestricted checking would be ${fmtCents(unrestricted)}: planned actions dip into the reserve or fund earmarks.`,
      ref: reserveAccount?.id,
    });
  }

  // --- daily liquidity per bank account
  const end = addDays(input.today, input.settings.horizonDays);
  const movementsFor = (accountId: string, extra: Movement[] = []): Movement[] => [
    ...confirmed.flatMap((a) =>
      legEffects(a)
        .filter((l) => l.accountId === accountId && l.remaining !== 0)
        .map((l) => ({ date: a.date ?? input.today, amount: l.remaining, label: a.label })),
    ),
    ...input.flows
      .filter((f) => f.accountId === accountId && f.date >= input.today && f.date <= end && !coveredFlowIds.has(f.id))
      .filter((f) => f.amount < 0 || f.reliable)
      .map((f) => ({ date: f.date, amount: f.amount, label: f.label })),
    ...extra,
  ];
  const liquidity: LiquidityResult[] = accounts
    .filter((a) => isBank(a.kind) && start.has(a.id))
    .map((a) => {
      const sim = simulateAccount(start.get(a.id)!, movementsFor(a.id));
      return { accountId: a.id, minBalance: sim.minBalance, minDate: sim.minDate, overdraft: sim.overdraft };
    });
  for (const l of liquidity) {
    if (l.overdraft) {
      issue({
        code: "overdraft",
        blocking: true,
        message: `${label(l.accountId)} would go below zero on ${l.overdraft.date} (“${l.overdraft.cause}”)${l.overdraft.nextInflow ? `, before the ${l.overdraft.nextInflow} inflow` : ""}. Move it later or fund it first.`,
        ref: l.accountId,
      });
    }
  }

  // --- card payments: basis, duplicates, suggestions
  const suggestions: CardSuggestion[] = [];
  for (const card of accounts.filter((a) => a.kind === "credit_card")) {
    const payments = live.filter((a) => a.kind === "card_payment" && a.toAccountId === card.id);
    const basis = card.cardBasis ?? null;
    for (const p of payments) {
      const b = p.cardBasis ?? basis;
      if (!b)
        issue({
          code: "card_basis_missing",
          blocking: true,
          message: `Choose statement or current balance for ${card.name} before planning payments.`,
          ref: p.id,
        });
      else if (b === "statement") {
        const st = balance.get(card.id)?.statement;
        if (!st || st.balance === null || st.paymentsCredited === null) {
          issue({
            code: "statement_missing",
            blocking: true,
            message: `${card.name} is paid by statement: enter the statement balance and payments already credited to it.`,
            ref: p.id,
          });
        }
      }
    }
    const snap = balance.get(card.id);
    if (!snap) continue;
    // Payments not yet in the card snapshot: planned or in transit. Included ones are already in the balance.
    const pending = payments.filter((p) => legEffects(p).some((l) => l.side === "destination" && l.inclusion !== "included")).reduce((s, p) => s + p.amount, 0);
    const unknownLeg = payments.some((p) => legEffects(p).some((l) => l.inclusion === "unknown"));
    let owed: Cents | null = null;
    if (basis === "current") owed = Math.max(0, -snap.balance);
    else if (basis === "statement" && snap.statement && snap.statement.balance !== null && snap.statement.paymentsCredited !== null) {
      owed = Math.max(0, snap.statement.balance - snap.statement.paymentsCredited);
    }
    if (owed !== null && pending > owed) {
      issue({
        code: "duplicate_payment",
        blocking: true,
        message: `Planned and in-transit payments to ${card.name} (${fmtCents(pending)}) exceed what's owed (${fmtCents(owed)}). One may be a duplicate.`,
        ref: card.id,
      });
    }
    const date = snap.statement?.dueDate && snap.statement.dueDate >= input.today ? snap.statement.dueDate : input.today;
    const suggested = owed === null ? 0 : Math.max(0, owed - pending);
    const s: CardSuggestion = { accountId: card.id, basis, owed, pending, suggested, date, source: { kind: "decision" } };
    if (!basis) s.blockedReason = "Choose statement or current balance for this card.";
    else if (owed === null) s.blockedReason = "Enter the statement balance and payments credited to it.";
    else if (unknownLeg) s.blockedReason = "Confirm whether existing payments are already in the snapshot first.";
    else if (suggested > 0) {
      const overdraws = (accountId: string) =>
        simulateAccount(start.get(accountId) ?? 0, movementsFor(accountId, [{ date, amount: -suggested, label: `Pay ${card.name}` }])).overdraft;
      if (reserve.accountId && unrestricted !== null && suggested <= unrestricted && !overdraws(reserve.accountId)) {
        s.source = { kind: "checking", accountId: reserve.accountId };
      } else {
        const savings = accountSummaries
          .filter((x) => byId.get(x.accountId)?.kind === "savings" && x.unassigned !== null && x.unassigned >= suggested)
          .sort((a, b) => (b.unassigned ?? 0) - (a.unassigned ?? 0))[0];
        if (savings && !overdraws(savings.accountId)) s.source = { kind: "savings", accountId: savings.accountId };
        else s.blockedReason = "No source covers it without dipping into the reserve or funds. Needs a decision.";
      }
    }
    if (snap.balance < 0 || suggested > 0 || pending > 0) suggestions.push(s);
  }

  // --- freshness
  const staleMs = input.settings.staleHours * 3_600_000;
  for (const a of accounts) {
    const b = balance.get(a.id);
    if (!b) continue;
    if (!b.asOf) issue({ code: "asof_unknown", blocking: false, message: `${a.name}: the provider didn't say how current this balance is.`, ref: a.id });
    else if (Date.parse(input.now) - Date.parse(b.asOf) > staleMs) {
      issue({ code: "stale_balance", blocking: false, message: `${a.name}: balance is older than ${input.settings.staleHours} hours.`, ref: a.id });
    }
  }
  if (input.refreshRunning) issue({ code: "refresh_running", blocking: true, message: "A balance refresh is running. Wait for it to finish." });
  if (input.unmatchedTransactions) {
    issue({
      code: "unmatched_transactions",
      blocking: false,
      message: `${input.unmatchedTransactions} recent transaction${input.unmatchedTransactions === 1 ? "" : "s"} not matched to an action.`,
    });
  }

  const ack = new Set(input.acknowledged ?? []);
  const blocking = issues.filter((i) => i.blocking).length;
  const unacknowledged = issues.filter((i) => !i.blocking && !ack.has(issueKey(i))).length;
  return {
    rows,
    ifReceived,
    accounts: accountSummaries,
    starting,
    change: changeTotals,
    ending,
    inTransit,
    conservation,
    reserve,
    liquidity,
    funds,
    suggestions,
    issues,
    blocking,
    unacknowledged,
    canClose: blocking === 0 && unacknowledged === 0,
  };
}
