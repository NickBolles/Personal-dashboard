# Finance

A household month-end check-in and a long-term plan, built from `PRODUCT_PLAN.md` (the finance investigation). **Jarvis never moves money.** It tells you what to pay, from where, and whether the month still works. You make the payments at your bank, then record them.

Pages: **Finance** (overview), **Check-in**, **Accounts**, **Funds**, **Plan** (web). The phone app shows the overview and opens the check-in on the web.

## Who sees it

- `finance.view` and `finance.edit` are capabilities (Settings → People). The owner has both. Adults get them by default; kids and the household tablet never do. Turn them off for an adult in Settings → People.
- Finance is never sent to Hermes or Claude. AI over finances is a non-goal in the plan.
- Notifications are opt-in: the finance category is off by default. They never include amounts, account names or institutions. They only say "October check-in is ready to review", "needs attention (2 items)" or "Balance refresh failed".
- **Hide amounts**: a per-browser and per-phone toggle replaces every amount with •••••.

## Vocabulary and rules (`lib/finance/`)

All money is integer cents. `engine.ts` and `plan.ts` are pure functions, unit-tested in `engine.test.ts`.

| Rule                                                                                  | Where                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two labelled totals: **Net position** (all accounts) and **Liquid cash** (banks only) | `computeCheckin`. Both are always shown.                                                                                                                                                                                 |
| The checking **reserve** is a restriction on checking, never subtracted from totals   | `computeReserve`. "Unrestricted checking" = checking − reserve.                                                                                                                                                          |
| Funds and the reserve cover disjoint obligations                                      | An obligation is funded by a fund or by the reserve, never both. Overlap is a hard validation error.                                                                                                                     |
| Pay-from account and fund are independent (F3)                                        | An action pays from an account; the fund it draws on is a separate choice, so a fund held in savings can pay a card from checking.                                                                                       |
| Snapshot inclusion is per leg, separate from action status                            | Each leg is `included`, `not_included` or `unknown` in the balance snapshot. A leg already in the snapshot contributes no further change, whatever the action's status. `unknown` blocks closing.                        |
| Daily liquidity simulation, outflows first                                            | `simulateAccount` walks each day; same-day outflows are applied before inflows. Any account going below zero blocks; the cushion sizes the reserve (`computeReserve`: cushion + peak outflow, or the larger of the two). |
| Protected funds need an explicit decision                                             | Drawing on a protected fund is blocked until a person acknowledges it on that action.                                                                                                                                    |
| No duplicate payments                                                                 | Planned plus in-transit payments to a card that exceed what's owed block as a possible duplicate. Matching an imported transaction to a leg is explicit.                                                                 |
| Hard validation is unwaivable                                                         | Blocking issues can't be acknowledged away. Warnings can be acknowledged (audited).                                                                                                                                      |
| Closed check-ins are immutable                                                        | Closing freezes the snapshot, results and fund movements. Later edits go to the next month.                                                                                                                              |
| Optimistic versions                                                                   | Every editable row has a `version`. A stale write gets a 409, never a silent last-write-wins.                                                                                                                            |
| Fund consumption per cycle                                                            | `fin_fund_movements` records consume/release per check-in cycle, so re-running a draft never double-counts.                                                                                                              |
| Plan actuals are stored, and corrections are audited (F5)                             | `computePlan` uses recorded actual allocations. A correction is a new row pointing at the old one, never an edit.                                                                                                        |

## Balances

`Settings → Connections → Finance` sets where balances come from:

- **Manual / CSV** (the default; always works).
  - Balances CSV columns: `account`, `balance`, optional `as_of`, `statement_balance`, `payments_credited`, `due_date`.
  - Transactions CSV (one account per file): `date`, `amount`, `description`, optional `pending`.
  - Overlaps with another source are flagged _ambiguous_ for a person; they are never merged silently.
- **Monarch** (unofficial GraphQL API, `integrations/monarch/client.ts`).
  - Asks Monarch to sync, waits up to `refreshWaitSeconds`, then reads balances with Monarch's own as-of time. If Monarch doesn't give one, the as-of is unknown and is never "now".
  - Liabilities are stored negative.
  - The session token is an encrypted server-side secret. It never reaches the browser and is never logged.

**Release blocker:** Monarch has no supported API. Until one refresh succeeds against a real (non-mock) account, the overview, the check-in and the phone show "Release blocker: Monarch hasn't worked with your real account yet". The first real success records `finance_monarch_validated`. Also check with one real card that a balance owed shows as negative. If it shows positive, flip the sign in `client.ts`.

Refreshes run one at a time (a lease in `fin_runs`) and finish with exactly one notice per outcome.

## Audit

Every finance write records before and after in `audit_log` (`auditFinance`), visible to the owner in Settings → Activity log. Account masks (last four digits) are never stored.
