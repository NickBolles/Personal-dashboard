"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/client/api";
import type { DecisionEntry } from "@/lib/decisions";
import { ErrorNote, Page, PageHeader, EmptyState, Skeleton } from "@/components/ui";
import { ButtonLink, Card } from "@/components/ui/legacy";
import { DecisionAnswer } from "./DecisionAnswer";

export function DecisionDetail({ id, initialChoice = "" }: { id: string; initialChoice?: string }) {
  const q = useQuery({
    queryKey: ["work", "decision", id],
    queryFn: () => api.get<{ entry: DecisionEntry }>(`/api/work/decisions/${encodeURIComponent(id)}`),
    retry: false,
  });
  const e = q.data?.entry;
  return (
    <Page width="narrow">
      <PageHeader
        title="Decision"
        eyebrow={
          <ButtonLink href="/decisions" variant="ghost" size="sm">
            Needs you
          </ButtonLink>
        }
      />
      {q.isPending ? (
        <div role="status" aria-label="Loading decision">
          <Skeleton />
          <Skeleton />
        </div>
      ) : null}
      {!e && q.error ? (
        q.error instanceof ApiError && q.error.status === 404 ? (
          <EmptyState title="Decision not found">It may already be answered, or you may not have access.</EmptyState>
        ) : (
          <ErrorNote error={q.error} retry={() => q.refetch()} />
        )
      ) : null}
      {e ? (
        <Card>
          <section className="min-w-0 space-y-3" aria-labelledby="decision-question">
            <p className="text-xs text-muted">
              {e.areaTitle ? `${e.areaTitle} › ` : ""}
              {e.title}
            </p>
            <h2 id="decision-question" className="text-lg font-semibold [overflow-wrap:anywhere]">
              {e.question}
            </h2>
            {e.detail ? (
              <div className="min-w-0 rounded-md border border-line bg-surface-2 p-3 text-sm" data-testid="decision-detail">
                <p className="mb-1 text-xs font-semibold text-muted">Proposed content</p>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{e.detail}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <ButtonLink href={e.href} size="sm">
                {e.kind === "item"
                  ? "Open item"
                  : e.kind === "approval"
                    ? "Open conversation to approve or deny"
                    : e.kind === "workflow"
                      ? "Review proposals"
                      : "Open run context"}
              </ButtonLink>
            </div>
            {e.kind === "item" && e.itemId ? (
              <DecisionAnswer key={e.key} entry={e} initialChoice={initialChoice} />
            ) : (
              <p className="text-sm text-muted">
                Review and confirm in the linked {e.kind === "approval" ? "conversation" : "context"}. Nothing is applied from this page.
              </p>
            )}
          </section>
        </Card>
      ) : null}
    </Page>
  );
}
