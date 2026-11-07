"use client";

import { Card } from "@/components/ui";
import dynamic from "next/dynamic";
import { SectionHeader, Skeleton } from "@/components/ui/kit";
import { Money, Delta, useHideAmounts } from "./money";
import type { FinanceSnapshot } from "@/lib/finance/snapshot";

const CashFlowSparkline = dynamic(() => import("./FinanceCashFlowSparkline").then((m) => m.FinanceCashFlowSparkline), {
  ssr: false,
  loading: () => <Skeleton w={160} h={36} className="mt-2 block max-w-full" />,
});

export function FinanceSnapshotCards({ snapshot }: { snapshot: FinanceSnapshot }) {
  const { hidden } = useHideAmounts();
  return (
    <section aria-labelledby="finance-snapshot-h" className="space-y-2">
      <h2 id="finance-snapshot-h" className="text-sm font-semibold">
        Snapshot
      </h2>
      <div className="grid min-w-0 grid-cols-1 gap-3 @min-[640px]:grid-cols-3">
        <Card className="min-w-0">
          <SectionHeader label="Net worth" />
          <p className="mt-2 break-words text-2xl">
            <Money value={snapshot.netWorth} strong />
          </p>
          <p className="mt-1 text-xs text-muted">Recorded accounts only · latest balances, not plans</p>
        </Card>
        <Card className="min-w-0">
          <SectionHeader label="Cash flow this month" />
          {snapshot.cashFlow ? (
            <>
              <p className="mt-2 break-words text-2xl">
                <Delta value={snapshot.cashFlow.net} />
              </p>
              {!hidden ? <CashFlowSparkline values={snapshot.cashFlow.points.map((p) => p.value)} /> : null}
              <p className="mt-1 text-xs text-muted">Posted bank movement · excludes pending and ambiguous entries</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">No posted bank transactions this month. Import transactions to see cash flow.</p>
          )}
        </Card>
        <Card className="min-w-0">
          <SectionHeader label="Accounts" />
          <p className="mt-2 text-2xl font-semibold tabular-nums">{snapshot.accounts}</p>
          <p className="mt-1 text-xs text-muted">Active accounts · archived accounts excluded</p>
        </Card>
      </div>
    </section>
  );
}
