/**
 * Check-in and plan arithmetic against the product plan's acceptance
 * criteria (AC-xx) and its additional test list. All figures synthetic.
 */
import { describe, expect, it } from "vitest";
import { allocateFundDraw, computeCheckin, computeReserve, type CheckinInput } from "./engine";
import { computePlan, type ActualInstallment, type EventEstimate, type PlanEvent } from "./plan";
import { issueKey, type FinAccount, type FinAction, type Inclusion } from "./types";

const $ = (d: number) => Math.round(d * 100);
const TODAY = "2026-10-01";
const NOW = "2026-10-01T15:00:00Z";

const accounts: FinAccount[] = [
  { id: "chk", name: "Joint checking", kind: "checking", reserveAccount: true },
  { id: "sav", name: "Savings", kind: "savings" },
  { id: "visa", name: "Visa", kind: "credit_card", cardBasis: "current" },
  { id: "amex", name: "Amex", kind: "credit_card", cardBasis: "statement" },
];

function base(over: Partial<CheckinInput> = {}): CheckinInput {
  return {
    today: TODAY,
    now: NOW,
    accounts,
    balances: [
      { accountId: "chk", balance: $(10_000), semantics: "current", source: "manual", asOf: "2026-10-01T12:00:00Z", fetchedAt: NOW },
      { accountId: "sav", balance: $(48_500), semantics: "current", source: "manual", asOf: "2026-10-01T12:00:00Z", fetchedAt: NOW },
      { accountId: "visa", balance: $(-1_500), semantics: "current", source: "manual", asOf: "2026-10-01T12:00:00Z", fetchedAt: NOW },
      {
        accountId: "amex",
        balance: $(-900),
        semantics: "current",
        source: "manual",
        asOf: "2026-10-01T12:00:00Z",
        fetchedAt: NOW,
        statement: { balance: $(700), paymentsCredited: $(200), dueDate: "2026-10-20" },
      },
    ],
    actions: [],
    funds: [],
    holdings: [],
    flows: [],
    settings: { mode: "additive", horizonDays: 30, cushion: $(2_000), staleHours: 24 },
    ...over,
  };
}

let n = 0;
function action(p: Partial<FinAction> & Pick<FinAction, "kind" | "amount">, legs: Partial<Record<"source" | "destination", Inclusion>> = {}): FinAction {
  const a: FinAction = {
    id: p.id ?? `a${++n}`,
    label: p.label ?? p.kind,
    status: "planned",
    date: TODAY,
    legs: [],
    ...p,
  } as FinAction;
  a.legs = (["source", "destination"] as const)
    .filter((s) => legs[s])
    .map((s) => ({ side: s, accountId: (s === "source" ? a.fromAccountId : a.toAccountId)!, inclusion: legs[s]! }));
  return a;
}
const codes = (r: ReturnType<typeof computeCheckin>) => r.issues.map((i) => i.code);

describe("grid, totals and conservation", () => {
  it("AC-08: transfers and card payments don't change net position; a card payment reduces liquid cash", () => {
    const r = computeCheckin(
      base({
        actions: [
          action({ kind: "transfer", amount: $(1_000), fromAccountId: "sav", toAccountId: "chk" }),
          action({ kind: "card_payment", amount: $(1_500), fromAccountId: "chk", toAccountId: "visa" }),
        ],
      }),
    );
    expect(r.change.net).toBe(0);
    expect(r.change.liquid).toBe($(-1_500));
    expect(r.rows.every((row) => row.rowNet === 0)).toBe(true);
    expect(r.conservation.ok).toBe(true);
  });

  it("AC-05: an action already in the snapshot (both legs) contributes zero delta", () => {
    const r = computeCheckin(
      base({
        actions: [
          action(
            { kind: "card_payment", amount: $(500), fromAccountId: "chk", toAccountId: "visa", status: "settled" },
            { source: "included", destination: "included" },
          ),
        ],
      }),
    );
    expect(r.rows[0]!.deltas).toEqual({ chk: 0, visa: 0 });
    expect(r.ending).toEqual(r.starting);
  });

  it("AC-06: source leg posted, destination not → in transit; net + in-transit = pre-payment net", () => {
    const prePaymentNet = $(10_000 + 48_500 - 1_500 - 900);
    // Checking already shows the payment; the card doesn't yet.
    const balances = base().balances.map((b) => (b.accountId === "chk" ? { ...b, balance: $(10_000 - 1_500) } : b));
    const r = computeCheckin(
      base({
        balances,
        actions: [
          action(
            { kind: "card_payment", amount: $(1_500), fromAccountId: "chk", toAccountId: "visa", status: "initiated" },
            { source: "included", destination: "excluded" },
          ),
        ],
      }),
    );
    expect(r.rows[0]!.inTransit).toBe(true);
    expect(r.inTransit).toBe($(1_500));
    expect(r.starting.net + r.inTransit).toBe(prePaymentNet);
    expect(r.conservation.ok).toBe(true);
  });

  it("source-first and destination-first settlement both bridge correctly", () => {
    const destFirst = computeCheckin(
      base({
        actions: [action({ kind: "transfer", amount: $(300), fromAccountId: "sav", toAccountId: "chk" }, { source: "excluded", destination: "included" })],
      }),
    );
    expect(destFirst.rows[0]!.inTransit).toBe(true);
    expect(destFirst.rows[0]!.deltas).toEqual({ sav: $(-300), chk: 0 });
    expect(destFirst.inTransit).toBe($(-300));
    expect(destFirst.conservation.ok).toBe(true);
  });

  it("AC-09: anticipated refunds are shown separately and excluded from totals and the reserve", () => {
    const r = computeCheckin(base({ actions: [action({ kind: "anticipated_refund", amount: $(80), toAccountId: "visa", label: "Shoes return" })] }));
    expect(r.rows).toHaveLength(0);
    expect(r.ifReceived[0]!.deltas).toEqual({ visa: $(80) });
    expect(r.ending).toEqual(r.starting);
    expect(r.reserve.unrestricted).toBe($(10_000 - 2_000));
  });

  it("AC-10: an unbalanced row blocks close and can't be acknowledged away", () => {
    const a = action({ kind: "transfer", amount: $(100), fromAccountId: "sav", toAccountId: null });
    const r = computeCheckin(base({ actions: [a], acknowledged: [issueKey({ code: "row_unbalanced", ref: a.id })] }));
    expect(codes(r)).toContain("row_unbalanced");
    expect(r.canClose).toBe(false);
  });

  it("AC-11: a leg on an account with no balance breaks conservation and blocks", () => {
    const r = computeCheckin(
      base({
        balances: base().balances.filter((b) => b.accountId !== "sav"),
        actions: [action({ kind: "transfer", amount: $(5), fromAccountId: "sav", toAccountId: "chk" })],
      }),
    );
    expect(codes(r)).toEqual(expect.arrayContaining(["balance_missing", "conservation"]));
  });

  it("running totals track both labeled totals row by row", () => {
    const r = computeCheckin(
      base({
        actions: [
          action({ kind: "external_outflow", amount: $(200), fromAccountId: "chk", date: "2026-10-02" }),
          action({ kind: "card_payment", amount: $(100), fromAccountId: "chk", toAccountId: "visa", date: "2026-10-03" }),
        ],
      }),
    );
    expect(r.rows.map((x) => [x.runningNet - r.starting.net, x.runningLiquid - r.starting.liquid])).toEqual([
      [$(-200), $(-200)],
      [$(-200), $(-300)],
    ]);
  });
});

describe("snapshot inclusion and freshness", () => {
  it("pending debit: included / excluded / unknown", () => {
    const mk = (inc: Inclusion) =>
      computeCheckin(base({ actions: [action({ kind: "external_outflow", amount: $(50), fromAccountId: "chk", status: "initiated" }, { source: inc })] }));
    expect(mk("included").ending.net).toBe(mk("included").starting.net);
    expect(mk("excluded").change.net).toBe($(-50));
    const unknown = mk("unknown");
    expect(codes(unknown)).toContain("inclusion_unknown");
    expect(unknown.canClose).toBe(false);
  });

  it("stale vs unknown timestamps are different warnings; neither invents freshness", () => {
    const balances = base().balances.map((b) =>
      b.accountId === "chk" ? { ...b, asOf: "2026-09-29T00:00:00Z" } : b.accountId === "sav" ? { ...b, asOf: null } : b,
    );
    const r = computeCheckin(base({ balances }));
    expect(r.issues.find((i) => i.ref === "chk")?.code).toBe("stale_balance");
    expect(r.issues.find((i) => i.ref === "sav")?.code).toBe("asof_unknown");
    expect(r.blocking).toBe(0);
    expect(r.canClose).toBe(false);
    const acked = computeCheckin(base({ balances, acknowledged: r.issues.map(issueKey) }));
    expect(acked.canClose).toBe(true);
  });

  it("missing dates must be confirmed", () => {
    const r = computeCheckin(base({ actions: [action({ kind: "external_outflow", amount: $(10), fromAccountId: "chk", date: null })] }));
    expect(codes(r)).toContain("date_missing");
  });
});

describe("reserve", () => {
  const flows = [
    { id: "rent", label: "Rent", accountId: "chk", amount: $(-3_000), date: "2026-10-03" },
    { id: "pay1", label: "Paycheck", accountId: "chk", amount: $(4_000), date: "2026-10-15", reliable: true },
    { id: "bonus", label: "Bonus", accountId: "chk", amount: $(9_000), date: "2026-10-10" },
    { id: "ins", label: "Insurance", accountId: "chk", amount: $(-2_000), date: "2026-10-20" },
  ];

  it("AC-14: additive = cushion + peak cumulative outflow; max = max(cushion, peak); unreliable inflows don't count", () => {
    const settings = { mode: "additive" as const, horizonDays: 30, cushion: $(2_000), staleHours: 24 };
    const add = computeReserve(flows, settings, "chk", TODAY, new Set());
    // -3000, +4000 (bonus ignored), -2000 → cumulative -3000, +1000, -1000: peak 3000
    expect(add.peak).toBe($(3_000));
    expect(add.required).toBe($(5_000));
    expect(computeReserve(flows, { ...settings, mode: "max" }, "chk", TODAY, new Set()).required).toBe($(3_000));
  });

  it("AC-13: the reserve restricts checking without reducing it or net position", () => {
    const r = computeCheckin(base({ flows }));
    expect(r.ending).toEqual(r.starting);
    expect(r.reserve.checkingAfter).toBe($(10_000));
    expect(r.reserve.unrestricted).toBe($(10_000 - 5_000));
  });

  it("AC-15: an obligation planned as a check-in action isn't also in the reserve", () => {
    const r = computeCheckin(
      base({ flows, actions: [action({ kind: "external_outflow", amount: $(3_000), fromAccountId: "chk", date: "2026-10-03", flowId: "rent" })] }),
    );
    expect(r.reserve.schedule.map((s) => s.flowId)).not.toContain("rent");
    // Rent now reduces checking directly; the paycheck lands before the insurance, so only the cushion is left.
    expect(r.reserve.peak).toBe(0);
    expect(r.reserve.required).toBe($(2_000));
    expect(r.reserve.unrestricted).toBe($(10_000 - 3_000 - 2_000));
  });

  it("a funded obligation is covered by its fund, not the reserve, but still needs cash on the day", () => {
    const funded = [{ id: "tax", label: "Property tax", accountId: "chk", amount: $(-12_000), date: "2026-10-05", fundId: "tax" }];
    const r = computeCheckin(base({ flows: funded }));
    expect(r.reserve.peak).toBe(0);
    expect(codes(r)).toContain("overdraft");
  });

  it("missing cushion blocks: there's no default amount", () => {
    expect(codes(computeCheckin(base({ settings: { mode: "additive", horizonDays: 30, cushion: null, staleHours: 24 } })))).toContain("cushion_missing");
  });
});

describe("daily liquidity", () => {
  it("a later paycheck can't fund an earlier debit (outflows first on the same day)", () => {
    const flows = [{ id: "pay", label: "Paycheck", accountId: "chk", amount: $(5_000), date: "2026-10-05", reliable: true }];
    const late = computeCheckin(
      base({ flows, actions: [action({ kind: "external_outflow", amount: $(12_000), fromAccountId: "chk", date: "2026-10-04", label: "Tuition" })] }),
    );
    expect(late.liquidity.find((l) => l.accountId === "chk")?.overdraft).toMatchObject({ date: "2026-10-04", cause: "Tuition", nextInflow: "2026-10-05" });
    expect(late.canClose).toBe(false);
    const sameDay = computeCheckin(
      base({ flows, actions: [action({ kind: "external_outflow", amount: $(12_000), fromAccountId: "chk", date: "2026-10-05" })] }),
    );
    expect(codes(sameDay)).toContain("overdraft");
    const after = computeCheckin(base({ flows, actions: [action({ kind: "external_outflow", amount: $(12_000), fromAccountId: "chk", date: "2026-10-06" })] }));
    expect(codes(after)).not.toContain("overdraft");
  });
});

describe("card payments", () => {
  it("AC-18 / Q2: no basis → blocked; statement basis without statement data → blocked, never a silent fallback", () => {
    const noBasis = accounts.map((a) => (a.id === "visa" ? { ...a, cardBasis: null } : a));
    const r = computeCheckin(
      base({ accounts: noBasis, actions: [action({ kind: "card_payment", amount: $(100), fromAccountId: "chk", toAccountId: "visa" })] }),
    );
    expect(codes(r)).toContain("card_basis_missing");
    expect(r.suggestions.find((s) => s.accountId === "visa")?.blockedReason).toMatch(/Choose/);
    const noStatement = base().balances.map((b) => (b.accountId === "amex" ? { ...b, statement: null } : b));
    const s = computeCheckin(
      base({ balances: noStatement, actions: [action({ kind: "card_payment", amount: $(100), fromAccountId: "chk", toAccountId: "amex" })] }),
    );
    expect(codes(s)).toContain("statement_missing");
    expect(s.suggestions.find((x) => x.accountId === "amex")).toMatchObject({ owed: null, suggested: 0 });
  });

  it("statement basis uses remaining statement amount minus verified payments", () => {
    const r = computeCheckin(base());
    expect(r.suggestions.find((s) => s.accountId === "amex")).toMatchObject({ basis: "statement", owed: $(500), suggested: $(500), date: "2026-10-20" });
  });

  it("a scheduled card payment suppresses a duplicate suggestion; an included one isn't deducted twice", () => {
    const planned = computeCheckin(base({ actions: [action({ kind: "card_payment", amount: $(1_500), fromAccountId: "chk", toAccountId: "visa" })] }));
    expect(planned.suggestions.find((s) => s.accountId === "visa")).toMatchObject({ owed: $(1_500), pending: $(1_500), suggested: 0 });
    // Paid 500 and it's already in the card balance (-1000 now): only 1000 more is owed, and the 500 isn't deducted again.
    const balances = base().balances.map((b) => (b.accountId === "visa" ? { ...b, balance: $(-1_000) } : b));
    const included = computeCheckin(
      base({
        balances,
        actions: [
          action(
            { kind: "card_payment", amount: $(500), fromAccountId: "chk", toAccountId: "visa", status: "settled" },
            { source: "included", destination: "included" },
          ),
        ],
      }),
    );
    expect(included.suggestions.find((s) => s.accountId === "visa")).toMatchObject({ owed: $(1_000), pending: 0, suggested: $(1_000) });
  });

  it("payments beyond what's owed are flagged as a possible duplicate and block close", () => {
    const r = computeCheckin(
      base({
        actions: [
          action({ kind: "card_payment", amount: $(1_500), fromAccountId: "chk", toAccountId: "visa" }),
          action({ kind: "card_payment", amount: $(1_500), fromAccountId: "chk", toAccountId: "visa" }),
        ],
      }),
    );
    expect(codes(r)).toContain("duplicate_payment");
  });

  it("AC-16: suggestions use unrestricted checking, then unassigned savings, else need a decision", () => {
    const fromChecking = computeCheckin(base());
    expect(fromChecking.suggestions.find((s) => s.accountId === "visa")?.source).toEqual({ kind: "checking", accountId: "chk" });
    // Big reserve: checking can't cover it without dipping in, so savings.
    const tight = computeCheckin(base({ settings: { mode: "additive", horizonDays: 30, cushion: $(9_000), staleHours: 24 } }));
    expect(tight.suggestions.find((s) => s.accountId === "visa")?.source).toEqual({ kind: "savings", accountId: "sav" });
    // Savings fully earmarked too: needs a decision.
    const earmarked = computeCheckin(
      base({
        settings: { mode: "additive", horizonDays: 30, cushion: $(9_000), staleHours: 24 },
        funds: [{ id: "em", name: "Emergency", protected: true }],
        holdings: [{ fundId: "em", accountId: "sav", amount: $(48_000) }],
      }),
    );
    const v = earmarked.suggestions.find((s) => s.accountId === "visa")!;
    expect(v.source.kind).toBe("decision");
    expect(v.blockedReason).toMatch(/decision/);
  });
});

describe("funds", () => {
  const funds = [
    { id: "travel", name: "Travel", protected: false },
    { id: "em", name: "Emergency", protected: true },
  ];
  const holdings = [
    { fundId: "travel", accountId: "sav", amount: $(4_000) },
    { fundId: "em", accountId: "sav", amount: $(15_000) },
  ];

  it("F3: a travel expense paid from checking draws Travel in savings; savings cash is unchanged", () => {
    const trip = action({ id: "trip", kind: "external_outflow", amount: $(3_000), fromAccountId: "chk", fundId: "travel" });
    const pending = computeCheckin(base({ funds, holdings, actions: [trip] }));
    const travel = pending.funds.find((f) => f.fundId === "travel")!;
    expect(travel.available).toBe($(1_000));
    const sav = pending.accounts.find((a) => a.accountId === "sav")!;
    expect(sav.end).toBe($(48_500));
    expect(sav.restricted).toBe($(16_000));
    expect(sav.unassigned).toBe($(32_500));

    // Settled and persisted: holdings drop to 1,000 and the action is marked consumed. Same answer, not double-counted.
    const settledBalances = base().balances.map((b) => (b.accountId === "chk" ? { ...b, balance: $(7_000) } : b));
    const settled = computeCheckin(
      base({
        balances: settledBalances,
        funds,
        holdings: [{ fundId: "travel", accountId: "sav", amount: $(1_000) }, holdings[1]!],
        consumedActionIds: ["trip"],
        actions: [{ ...trip, status: "settled", legs: [{ side: "source", accountId: "chk", inclusion: "included" }] }],
      }),
    );
    expect(settled.funds.find((f) => f.fundId === "travel")!.available).toBe($(1_000));
    expect(settled.accounts.find((a) => a.accountId === "sav")!.unassigned).toBe($(32_500));

    // Then an untagged 1,000 from savings: cash 47,500, unassigned 31,500.
    const untagged = computeCheckin(
      base({
        funds,
        holdings: [{ fundId: "travel", accountId: "sav", amount: $(1_000) }, holdings[1]!],
        actions: [action({ kind: "external_outflow", amount: $(1_000), fromAccountId: "sav" })],
      }),
    );
    const s2 = untagged.accounts.find((a) => a.accountId === "sav")!;
    expect(s2.end).toBe($(47_500));
    expect(s2.unassigned).toBe($(31_500));
  });

  it("draws come from the pay-from account first, then the largest holding", () => {
    const hs = [
      { fundId: "travel", accountId: "sav", amount: $(4_000) },
      { fundId: "travel", accountId: "chk", amount: $(500) },
    ];
    expect(allocateFundDraw("travel", $(1_000), "chk", hs)).toEqual({
      draws: [
        { accountId: "chk", amount: $(500) },
        { accountId: "sav", amount: $(500) },
      ],
      shortfall: 0,
    });
  });

  it("a checking earmark restricts checking once, not twice", () => {
    const hs = [{ fundId: "travel", accountId: "chk", amount: $(1_000) }];
    const idle = computeCheckin(base({ funds, holdings: hs }));
    expect(idle.reserve.checkingFundHoldings).toBe($(1_000));
    expect(idle.reserve.unrestricted).toBe($(10_000 - 2_000 - 1_000));
    // Spending it: checking drops by 1,000 and the earmark is reserved by the action, so unrestricted is unchanged.
    const spent = computeCheckin(
      base({ funds, holdings: hs, actions: [action({ kind: "external_outflow", amount: $(1_000), fromAccountId: "chk", fundId: "travel" })] }),
    );
    expect(spent.reserve.checkingFundHoldings).toBe(0);
    expect(spent.reserve.unrestricted).toBe(idle.reserve.unrestricted);
  });

  it("protected funds need an explicit decision; overdrawing a fund blocks", () => {
    const use = action({ kind: "external_outflow", amount: $(500), fromAccountId: "sav", fundId: "em" });
    expect(codes(computeCheckin(base({ funds, holdings, actions: [use] })))).toContain("fund_unauthorized");
    expect(codes(computeCheckin(base({ funds, holdings, actions: [{ ...use, fundDecision: true }] })))).not.toContain("fund_unauthorized");
    const big = action({ kind: "external_outflow", amount: $(5_000), fromAccountId: "chk", fundId: "travel" });
    expect(codes(computeCheckin(base({ funds, holdings, actions: [big] })))).toContain("fund_overdrawn");
  });

  it("AC-17: earmarks above the account balance warn", () => {
    const r = computeCheckin(base({ funds, holdings: [{ fundId: "travel", accountId: "chk", amount: $(12_000) }] }));
    expect(r.issues.find((i) => i.code === "fund_overallocated")).toMatchObject({ blocking: false, ref: "chk" });
  });
});

describe("long-term plan", () => {
  const funds = [
    { id: "travel", name: "Travel" },
    { id: "tax", name: "Tax" },
  ];
  const events: PlanEvent[] = [
    { id: "rsu", label: "RSU vest", kind: "income", status: "open" },
    { id: "trip", label: "Summer trip", kind: "obligation", status: "open" },
    { id: "q3", label: "Q3 estimated tax", kind: "obligation", status: "open" },
  ];
  const r1: EventEstimate[] = [
    { eventId: "rsu", date: "2026-03-01", amount: $(20_000), allocations: { travel: $(5_000), tax: $(14_000) } },
    { eventId: "trip", date: "2026-07-01", amount: $(-3_000), allocations: { travel: $(-3_000) } },
    { eventId: "q3", date: "2026-09-15", amount: $(-8_000), allocations: { tax: $(-4_000) } },
  ];

  it("AC-20: allocations must equal the amount; the remainder shows as Unallocated with attention", () => {
    const p = computePlan({ funds, openings: { travel: $(1_000) }, events, estimates: r1, actuals: [], mode: "plan" });
    expect(p.rows.find((r) => r.eventId === "rsu")).toMatchObject({ unallocated: $(1_000) });
    expect(p.rows.find((r) => r.eventId === "q3")).toMatchObject({ unallocated: $(-4_000) });
    expect(p.rows.find((r) => r.eventId === "trip")!.attention).toEqual([]);
    expect(p.endings.travel).toBe($(1_000 + 5_000 - 3_000));
  });

  it("AC-21/22: forecast = actuals for done events + estimates for the rest; variances", () => {
    const actuals: ActualInstallment[] = [
      {
        id: "x1",
        eventId: "rsu",
        date: "2026-03-05",
        amount: $(18_000),
        allocations: [
          { fundId: "travel", amount: $(4_000) },
          { fundId: "tax", amount: $(14_000) },
        ],
      },
    ];
    const done = events.map((e) => (e.id === "rsu" ? { ...e, status: "complete" as const } : e));
    const f = computePlan({ funds, openings: {}, events: done, estimates: r1, actuals, mode: "forecast" });
    const rsu = f.rows.find((r) => r.eventId === "rsu")!;
    expect(rsu).toMatchObject({ amount: $(18_000), unallocated: 0, variance: { amount: $(-2_000), days: 4 } });
    expect(f.rows.find((r) => r.eventId === "trip")!.amount).toBe($(-3_000));
    const a = computePlan({ funds, openings: {}, events: done, estimates: r1, actuals, mode: "actual" });
    expect(a.rows.map((r) => r.eventId)).toEqual(["rsu"]);
  });

  it("signed partial obligation: one of two installments paid, the rest still forecast", () => {
    const actuals: ActualInstallment[] = [
      { id: "i1", eventId: "q3", date: "2026-09-10", amount: $(-3_000), allocations: [{ fundId: "tax", amount: $(-3_000) }] },
    ];
    const partial = events.map((e) => (e.id === "q3" ? { ...e, status: "partial" as const } : e));
    const est = r1.map((e) => (e.eventId === "q3" ? { ...e, allocations: { tax: $(-8_000) } } : e));
    const f = computePlan({ funds, openings: {}, events: partial, estimates: est, actuals, mode: "forecast" });
    const q3 = f.rows.find((r) => r.eventId === "q3")!;
    expect(q3.amount).toBe($(-8_000));
    expect(q3.allocations.tax).toBe($(-8_000));
    // An explicit remaining amount wins over "estimate minus actual".
    const explicit = computePlan({
      funds,
      openings: {},
      events: partial.map((e) => (e.id === "q3" ? { ...e, remainingAmount: $(-4_000) } : e)),
      estimates: est,
      actuals,
      mode: "forecast",
    });
    expect(explicit.rows.find((r) => r.eventId === "q3")!.amount).toBe($(-7_000));
  });

  it("AC-23/24 + F5: actual allocations survive a revision switch; only an audited actual reallocation fixes them", () => {
    const actuals: ActualInstallment[] = [
      { id: "t1", eventId: "trip", date: "2026-07-02", amount: $(-3_500), allocations: [{ fundId: "travel", amount: $(-3_000) }] },
    ];
    const done = events.map((e) => (e.id === "trip" ? { ...e, status: "complete" as const } : e));
    const inR1 = computePlan({ funds, openings: {}, events: done, estimates: r1, actuals, mode: "forecast" });
    expect(inR1.rows.find((r) => r.eventId === "trip")!.unallocated).toBe($(-500));
    // R2 is only an estimate revision: it raises the estimate to 3,500 but the actual discrepancy remains.
    const r2 = r1.map((e) => (e.eventId === "trip" ? { ...e, amount: $(-3_500), allocations: { travel: $(-3_500) } } : e));
    const inR2 = computePlan({ funds, openings: {}, events: done, estimates: r2, actuals, mode: "forecast" });
    expect(inR2.rows.find((r) => r.eventId === "trip")).toMatchObject({ amount: $(-3_500), unallocated: $(-500) });
    expect(computePlan({ funds, openings: {}, events: done, estimates: r2, actuals, mode: "plan" }).rows.find((r) => r.eventId === "trip")!.unallocated).toBe(
      0,
    );
    // The audited correction: a separate -500 actual allocation from Travel.
    const corrected = [{ ...actuals[0]!, allocations: [...actuals[0]!.allocations, { fundId: "travel", amount: $(-500) }] }];
    const fixed = computePlan({ funds, openings: {}, events: done, estimates: r2, actuals: corrected, mode: "forecast" });
    expect(fixed.rows.find((r) => r.eventId === "trip")!.unallocated).toBe(0);
    // Identical history in either revision.
    const inR1b = computePlan({ funds, openings: {}, events: done, estimates: r1, actuals: corrected, mode: "actual" });
    const inR2b = computePlan({ funds, openings: {}, events: done, estimates: r2, actuals: corrected, mode: "actual" });
    expect(inR1b.rows).toEqual(
      inR2b.rows.map((r) => ({
        ...r,
        estimate: inR1b.rows.find((x) => x.eventId === r.eventId)!.estimate,
        variance: inR1b.rows.find((x) => x.eventId === r.eventId)!.variance,
      })),
    );
    expect(inR1b.endings).toEqual(inR2b.endings);
  });

  it("an event removed from a revision still shows its actuals", () => {
    const actuals: ActualInstallment[] = [
      { id: "t1", eventId: "trip", date: "2026-07-02", amount: $(-3_000), allocations: [{ fundId: "travel", amount: $(-3_000) }] },
    ];
    const hypothetical = r1.map((e) => (e.eventId === "trip" ? { ...e, removed: true } : e));
    const f = computePlan({ funds, openings: {}, events, estimates: hypothetical, actuals, mode: "forecast" });
    expect(f.rows.find((r) => r.eventId === "trip")).toMatchObject({ notInRevision: true, amount: $(-3_000) });
    expect(computePlan({ funds, openings: {}, events, estimates: hypothetical, actuals, mode: "plan" }).rows.some((r) => r.eventId === "trip")).toBe(false);
  });
});
