/**
 * Finance module vocabulary (docs/finance.md). Client-safe: the web UI, the
 * server and the phone share these. All money is integer cents. Sign
 * convention: assets positive, liabilities negative (a card you owe on is
 * negative; a card with a credit balance is positive).
 */
export type Cents = number;

export const ACCOUNT_KINDS = ["checking", "savings", "credit_card", "other_asset", "other_liability"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
/** Liquid cash = bank accounts only. */
export const BANK_KINDS: AccountKind[] = ["checking", "savings"];
export const isBank = (k: AccountKind) => BANK_KINDS.includes(k);

export type CardBasis = "statement" | "current";
export type BalanceSource = "monarch" | "manual" | "csv";
/** What the provider's number means: a pending debit may already reduce "available". */
export type BalanceSemantics = "current" | "available" | "statement";

export type FinAccount = {
  id: string;
  name: string;
  kind: AccountKind;
  /** cards only: the explicitly chosen basis for payment planning (no silent default) */
  cardBasis?: CardBasis | null;
  /** the checking account the reserve protects */
  reserveAccount?: boolean;
  archived?: boolean;
};

export type BalanceSnapshot = {
  accountId: string;
  balance: Cents;
  semantics: BalanceSemantics;
  source: BalanceSource;
  /** when the provider says the balance was true; null = unknown (never filled from fetch time) */
  asOf: string | null;
  fetchedAt: string;
  /** cards on statement basis */
  statement?: { balance: Cents | null; paymentsCredited: Cents | null; dueDate?: string | null } | null;
};

export const ACTION_KINDS = ["transfer", "card_payment", "external_outflow", "external_inflow", "anticipated_refund", "adjustment"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  transfer: "Transfer",
  card_payment: "Card payment",
  external_outflow: "Outflow",
  external_inflow: "Inflow",
  anticipated_refund: "Anticipated refund",
  adjustment: "Adjustment",
};
export const INTERNAL_KINDS: ActionKind[] = ["transfer", "card_payment"];

export type ActionStatus = "planned" | "initiated" | "settled" | "skipped" | "cancelled";
/** Is this leg's movement already in the snapshot balance? A separate fact from status. */
export type Inclusion = "included" | "excluded" | "unknown";
export type LegSide = "source" | "destination";

export type ActionLeg = {
  side: LegSide;
  accountId: string;
  inclusion: Inclusion;
  /** why we believe the inclusion (matched transaction, user confirmation…) */
  evidence?: string | null;
  transactionId?: string | null;
};

export type FinAction = {
  id: string;
  kind: ActionKind;
  label: string;
  /** positive cents; adjustments may be negative */
  amount: Cents;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  /** YYYY-MM-DD; missing dates must be confirmed before close */
  date?: string | null;
  status: ActionStatus;
  legs: ActionLeg[];
  /** purpose fund this movement draws on (independent of the pay-from account) */
  fundId?: string | null;
  /** explicit decision to use a protected fund */
  fundDecision?: boolean;
  /** reserve-schedule flow this action covers (so it isn't also in the reserve) */
  flowId?: string | null;
  cardBasis?: CardBasis | null;
  note?: string | null;
  /** order within the check-in */
  position?: number;
};

export type Fund = { id: string; name: string; protected: boolean; archived?: boolean };
/** Part of an account's balance earmarked for a fund. Not money; never changes balances. */
export type FundHolding = { fundId: string; accountId: string; amount: Cents };

/** A dated movement on the reserve schedule (paychecks, bills). Outflows negative. */
export type ScheduledFlow = {
  id: string;
  label: string;
  accountId: string;
  amount: Cents;
  date: string;
  /** inflows: only regular paychecks count before they post */
  reliable?: boolean;
  /** a funded obligation is covered by its fund, not by the reserve */
  fundId?: string | null;
};

export type ReserveSettings = {
  mode: "additive" | "max";
  horizonDays: number;
  /** user-entered; null until set (no default amount) */
  cushion: Cents | null;
  staleHours: number;
};

export type IssueCode =
  | "row_unbalanced"
  | "conservation"
  | "duplicate_payment"
  | "inclusion_unknown"
  | "fund_unauthorized"
  | "fund_overdrawn"
  | "date_missing"
  | "overdraft"
  | "card_basis_missing"
  | "statement_missing"
  | "cushion_missing"
  | "balance_missing"
  | "refresh_running"
  | "stale_balance"
  | "asof_unknown"
  | "unrestricted_negative"
  | "fund_overallocated"
  | "unmatched_transactions";

export type Issue = {
  code: IssueCode;
  /** blocking issues can't be acknowledged away */
  blocking: boolean;
  message: string;
  /** action / account / fund id the issue is about */
  ref?: string;
};

/** Stable key for acknowledging a warning. */
export const issueKey = (i: Pick<Issue, "code" | "ref">) => `${i.code}:${i.ref ?? ""}`;

export type FinanceStatus = "ready" | "attention" | "failed" | "setup";
