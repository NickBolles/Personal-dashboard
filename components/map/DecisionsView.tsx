"use client";

import Link from "next/link";
import { DecisionsList, useDecisions } from "./Decisions";

export function DecisionsView() {
  const q = useDecisions();
  return (
    <div className="mx-auto max-w-3xl px-3 pt-3 pb-24 sm:px-5" data-testid="decisions-page">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="wk-eyebrow">Decisions inbox</p>
          <h1 className="text-xl leading-tight font-semibold tracking-tight">Needs you</h1>
          <p className="mt-0.5 text-[13px] text-muted">Decisions on your work, Hermes approvals and workflow proposals. Nothing here settles on its own.</p>
        </div>
        <Link href="/map" className="k-pick inline-flex items-center px-3 text-[13px]">
          Open the map
        </Link>
      </header>
      {q.error ? <p className="text-sm text-danger">Couldn&apos;t load: {(q.error as Error).message}</p> : null}
      {q.data ? (
        <DecisionsList entries={q.data.entries} />
      ) : !q.error ? (
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
