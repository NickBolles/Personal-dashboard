import "server-only";
import { addDays, type CheckinResult } from "@/lib/finance/engine";
import type { Cents, FinanceStatus, Issue } from "@/lib/finance/types";
import { resolveIntegration } from "@/integrations/store";
import { listAccounts } from "./accounts";
import { financeSettings, monthName, thisMonth, today } from "./common";
import { currentResult } from "./checkins";
import { expandFlows, listFlows } from "./funds";
import { upcomingPlanEvents } from "./plan";
import { lastRun } from "./runs";
import { monarchValidation } from "./sync";

export type FinanceOverview = {
  /** this month in the household timezone (YYYY-MM) */
  month: string;
  status: FinanceStatus;
  statusText: string;
  /** oldest provider as-of among balances in use; null if any is unknown */
  asOf: string | null;
  setup: {
    accounts: number;
    cushionSet: boolean;
    balanceSource: "manual" | "monarch";
    monarchValidatedAt: string | null;
    /** Monarch is the chosen source but has never worked against a real account */
    releaseBlocker: boolean;
  };
  checkin: { id: string; month: string; status: string; blocking: number; warnings: number; open: number; canClose: boolean } | null;
  totals: { net: Cents; liquid: Cents; reserve: Cents | null; unrestricted: Cents | null; inTransit: Cents } | null;
  funds: CheckinResult["funds"];
  upcoming: { id: string; label: string; date: string; kind: "bill" | "paycheck" | "plan"; amount?: Cents }[];
  issues: Issue[];
  lastRun: { kind: string; status: string; outcome: string | null; at: string; error: string | null } | null;
};

export function financeOverview(now = new Date()): FinanceOverview {
  const accounts = listAccounts();
  const settings = financeSettings();
  const cfg = resolveIntegration("finance");
  const balanceSource = cfg.config.balanceSource === "monarch" ? "monarch" : "manual";
  const validated = monarchValidation();
  const res = currentResult(now);
  const run = lastRun();
  const t = today(now);
  const horizon = addDays(t, 30);
  const upcoming: FinanceOverview["upcoming"] = [
    ...expandFlows(listFlows(), t, horizon).map((f) => ({
      id: f.id,
      label: f.label,
      date: f.date,
      kind: (f.amount > 0 ? "paycheck" : "bill") as "bill" | "paycheck",
      amount: f.amount,
    })),
    ...upcomingPlanEvents(t, horizon).map((e) => ({ id: e.eventId, label: e.label, date: e.date, kind: "plan" as const })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 12);

  const r = res && res.checkin.status === "draft" ? res.result : undefined;
  const asOfs = accounts.map((a) => a.balance?.asOf);
  const asOf = asOfs.length && asOfs.every(Boolean) ? (asOfs as string[]).sort()[0]! : null;
  let status: FinanceStatus;
  let statusText: string;
  if (!accounts.length) {
    status = "setup";
    statusText = "Add your accounts to start.";
  } else if (run?.status === "failed") {
    status = "failed";
    statusText = "The last balance refresh failed.";
  } else if (!res || res.checkin.month !== thisMonth(now)) {
    status = "attention";
    statusText = `${monthName(thisMonth(now))} check-in not started.`;
  } else if (res.checkin.status === "closed") {
    status = "ready";
    statusText = `${monthName(res.checkin.month)} check-in is closed.`;
  } else if (r && r.issues.length) {
    status = "attention";
    statusText = `${monthName(res.checkin.month)} check-in needs attention (${r.issues.length}).`;
  } else {
    status = "ready";
    statusText = `${monthName(res.checkin.month)} check-in is ready to review.`;
  }
  const result = res?.result;
  return {
    month: thisMonth(now),
    status,
    statusText,
    asOf,
    setup: {
      accounts: accounts.length,
      cushionSet: settings.cushion !== null,
      balanceSource,
      monarchValidatedAt: validated?.at ?? null,
      releaseBlocker: balanceSource === "monarch" && !validated,
    },
    checkin: res
      ? {
          id: res.checkin.id,
          month: res.checkin.month,
          status: res.checkin.status,
          blocking: r?.blocking ?? 0,
          warnings: r ? r.issues.filter((i) => !i.blocking).length : 0,
          open: result!.rows.filter((x) => x.status === "planned" || x.status === "initiated").length,
          canClose: Boolean(r?.canClose),
        }
      : null,
    totals: result
      ? {
          net: result.ending.net,
          liquid: result.ending.liquid,
          reserve: result.reserve.required,
          unrestricted: result.reserve.unrestricted,
          inTransit: result.inTransit,
        }
      : null,
    funds: result?.funds ?? [],
    upcoming,
    issues: r?.issues ?? [],
    lastRun: run ? { kind: run.kind, status: run.status, outcome: run.outcome, at: run.finishedAt ?? run.startedAt, error: run.error } : null,
  };
}
