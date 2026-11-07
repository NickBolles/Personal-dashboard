"use client";

import { sparklinePoints } from "@/lib/finance/snapshot";

/** Decorative: the numeric cash-flow summary remains server-rendered and readable without the chart. */
export function FinanceCashFlowSparkline({ values }: { values: number[] }) {
  return (
    <svg viewBox="0 0 160 36" width="160" height="36" className="mt-2 max-w-full text-accent" aria-hidden="true" focusable="false">
      <polyline points={sparklinePoints([0, ...values])} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
