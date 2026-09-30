"use client";

import Link from "next/link";
import type { SourceStatus } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { Empty } from "@/components/ui";

/** Honest state for a source: unknown is never rendered as empty. Returns null when data is usable. */
export function SourceState({ status, hasData }: { status?: SourceStatus; hasData: boolean }) {
  if (!status) return null;
  if (status.state === "unconfigured" || status.state === "disabled") {
    return (
      <Empty
        title={`${status.label} isn’t connected`}
        action={
          <Link className="underline" href="/settings/connections">
            Connect {status.label}
          </Link>
        }
      >
        Jarvis doesn’t know this source’s state yet.
      </Empty>
    );
  }
  if ((status.state === "error" || status.state === "unauthorized") && !hasData) {
    return (
      <div role="alert" className="rounded-[var(--radius)] border border-danger bg-danger-soft p-4 text-sm text-danger">
        <p className="font-semibold">{status.state === "unauthorized" ? `${status.label} needs re-authentication` : `Couldn’t load ${status.label}`}</p>
        {status.error ? <p className="mt-1">{status.error}</p> : null}
        <Link href="/settings/connections" className="mt-2 inline-block underline">
          Check connection
        </Link>
      </div>
    );
  }
  if (status.state === "error" || status.state === "unauthorized" || status.state === "stale") {
    return (
      <p role="status" className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
        Showing data from {status.fetchedAt ? relativeTime(status.fetchedAt) : "earlier"}
        {status.error ? ` — ${status.error}` : ""}
      </p>
    );
  }
  return null;
}
