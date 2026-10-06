import "server-only";
import { MINUTE } from "@/lib/time";
import { addDays } from "@/lib/finance/engine";
import { baseAction, classifyDateOnly } from "@/integrations/actions";
import { runChecks } from "@/integrations/testing";
import type { NextAction } from "@/lib/contracts";
import type { SourceAdapter } from "@/integrations/types";
import { listAccounts } from "@/server/finance/accounts";
import { monthName, thisMonth } from "@/server/finance/common";
import { checkinActions, currentResult } from "@/server/finance/checkins";
import { upcomingPlanEvents } from "@/server/finance/plan";
import { monarchValidation } from "@/server/finance/sync";
import { listAccounts as listMonarchAccounts, monarchConn } from "@/integrations/monarch/client";
import { resolveIntegration } from "@/integrations/store";

const STALE = 5 * MINUTE;

/**
 * Finance items on Home, ranked with everything else: the month's check-in,
 * what needs fixing, money moves due soon, and plan obligations coming up.
 * Titles never carry amounts.
 */
export const financeAdapter: SourceAdapter = {
  source: "finance",
  staleAfterMs: STALE,
  async fetch(ctx) {
    const actions: NextAction[] = [];
    const accounts = listAccounts();
    const add = (id: string, rest: Parameters<typeof baseAction>[4]) => actions.push(baseAction("finance", id, ctx, STALE, rest));
    if (!accounts.length) {
      add("setup", {
        title: "Set up finances",
        detail: "Add your accounts and the checking cushion",
        status: "open",
        priorityReason: "upcoming",
        updatedAt: ctx.now.toISOString(),
        href: "/finance/accounts",
        primaryAction: { kind: "open", label: "Set up" },
      });
      return { actions };
    }
    const month = thisMonth(ctx.now);
    const res = currentResult(ctx.now);
    const dayOfMonth = Number(ctx.today.slice(8, 10));
    if (!res || res.checkin.month !== month) {
      add(`checkin:${month}:start`, {
        title: `Start the ${monthName(month)} check-in`,
        detail: "Refresh balances, plan card payments, check the reserve",
        status: "open",
        priorityReason: dayOfMonth <= 7 ? "checkin_window" : "today",
        updatedAt: ctx.now.toISOString(),
        href: "/finance",
        primaryAction: { kind: "open", label: "Start" },
      });
    } else if (res.checkin.status === "draft") {
      const r = res.result;
      const fix = r.issues.filter((i) => i.blocking).length;
      const warn = r.issues.length - fix;
      add(`checkin:${res.checkin.id}`, {
        title: fix
          ? `${monthName(month)} check-in: ${fix} thing${fix === 1 ? "" : "s"} to fix`
          : r.canClose
            ? `${monthName(month)} check-in is ready to close`
            : `${monthName(month)} check-in: review ${warn} warning${warn === 1 ? "" : "s"}`,
        detail: "Budget review and balancing",
        status: "open",
        priorityReason: fix ? "awaiting_user" : "today",
        updatedAt: ctx.now.toISOString(),
        href: `/finance/checkin/${res.checkin.id}`,
        primaryAction: { kind: "open", label: "Review" },
      });
      if (r.issues.some((i) => i.code === "stale_balance" || i.code === "asof_unknown")) {
        add("refresh", {
          title: "Refresh balances",
          detail: "Some balances are old or of unknown age",
          status: "open",
          priorityReason: "today",
          updatedAt: ctx.now.toISOString(),
          href: "/finance/accounts",
          primaryAction: { kind: "open", label: "Refresh" },
        });
      }
      for (const a of checkinActions(res.checkin.id)) {
        if (a.status !== "planned" || !a.date || a.date > addDays(ctx.today, 2)) continue;
        const due = classifyDateOnly(a.date, ctx);
        add(`action:${a.id}`, {
          title: `Mark done when it's sent: ${a.label}`,
          status: "open",
          priorityReason: due.reason,
          dueAt: due.dueAt,
          dueIsDate: true,
          updatedAt: ctx.now.toISOString(),
          href: `/finance/checkin/${res.checkin.id}#${a.id}`,
          primaryAction: { kind: "open", label: "Open" },
        });
      }
    }
    for (const e of upcomingPlanEvents(ctx.today, addDays(ctx.today, 14))) {
      if (e.kind === "reallocation") continue;
      const due = classifyDateOnly(e.date, ctx);
      add(`plan:${e.eventId}`, {
        title: e.kind === "income" ? `Expected: ${e.label}` : `Coming up: ${e.label}`,
        detail: "From the long-term plan",
        status: "open",
        priorityReason: due.reason === "upcoming" ? "upcoming" : due.reason,
        dueAt: due.dueAt,
        dueIsDate: true,
        updatedAt: ctx.now.toISOString(),
        href: `/finance/plan?year=${e.year}`,
        primaryAction: { kind: "open", label: "Open" },
      });
    }
    if (resolveIntegration("finance").config.balanceSource === "monarch" && !monarchValidation()) {
      add("monarch", {
        title: "Monarch connection not validated yet",
        detail: "Release blocker: refresh once with your real account",
        status: "open",
        priorityReason: "upcoming",
        updatedAt: ctx.now.toISOString(),
        href: "/finance/accounts",
        primaryAction: { kind: "open", label: "Open" },
      });
    }
    return { actions };
  },
  async test() {
    const source = resolveIntegration("finance").config.balanceSource;
    if (source !== "monarch") return runChecks([{ name: "Manual and CSV balances", run: async () => "Ready (no connector needed)" }]);
    return runChecks([
      {
        name: "Read accounts from Monarch",
        run: async () => {
          const list = await listMonarchAccounts(monarchConn());
          const unknown = list.filter((a) => !a.asOf).length;
          return `${list.length} accounts${unknown ? `, ${unknown} without an as-of time` : ""}`;
        },
      },
    ]);
  },
};
