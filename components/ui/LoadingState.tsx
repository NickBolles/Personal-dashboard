"use client";

import { Skeleton } from "./kit";

/** Named status plus decorative kit skeletons; retain the route's loading copy for assistive technology. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-3 py-3">
      <span className="sr-only">{label}</span>
      <Skeleton h={16} w="60%" className="block" />
      <Skeleton h={44} className="block" />
      <Skeleton h={44} className="block" />
    </div>
  );
}
