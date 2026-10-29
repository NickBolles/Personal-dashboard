"use client";

import type { SourceStatus } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { Banner, ButtonLink, EmptyState } from "@/components/ui/kit";

/**
 * Per-source state (design system §States): unknown is never rendered as empty.
 * - not connected → empty state with one action (Connect)
 * - error/unauthorized without cached data → danger banner + Check connection
 * - error/unauthorized/stale with cached data → warning banner, cached data stays visible
 * Returns null when data is usable.
 */
export function SourceBanner({ status, hasData }: { status?: SourceStatus; hasData: boolean }) {
  if (!status) return null;
  if (status.state === "unconfigured" || status.state === "disabled") {
    return (
      <EmptyState
        title={`${status.label} isn’t connected`}
        action={
          <ButtonLink href="/settings/connections" variant="primary" size="sm">
            Connect {status.label}
          </ButtonLink>
        }
      >
        Jarvis doesn’t know this source’s state yet.
      </EmptyState>
    );
  }
  if ((status.state === "error" || status.state === "unauthorized") && !hasData) {
    return (
      <Banner
        tone="bad"
        action={
          <ButtonLink href="/settings/connections" variant="secondary" size="sm">
            Check connection
          </ButtonLink>
        }
      >
        <span className="block font-semibold">
          {status.state === "unauthorized" ? `${status.label} needs re-authentication` : `Couldn’t load ${status.label}`}
        </span>
        {status.error ? <span className="mt-0.5 block text-[13px] text-[var(--t2)]">{status.error}</span> : null}
      </Banner>
    );
  }
  if (status.state === "error" || status.state === "unauthorized" || status.state === "stale") {
    return (
      <Banner tone="wn">
        Showing data from {status.fetchedAt ? relativeTime(status.fetchedAt) : "earlier"}
        {status.error ? ` — ${status.error}` : ""}
      </Banner>
    );
  }
  return null;
}

/** @deprecated use SourceBanner */
export const SourceState = SourceBanner;
