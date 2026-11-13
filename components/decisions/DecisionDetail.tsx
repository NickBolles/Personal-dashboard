"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/client/api";
import type { DecisionEntry } from "@/lib/decisions";
import { viewOfEntry } from "@/lib/decision-view";
import { ButtonLink, Card, EmptyState, ErrorNote, Page, PageHeader, Skeleton, useNow } from "@/components/ui";
import { DecisionCard, DecisionNotices, DecisionReceiptLine } from "./DecisionBlock";
import { useDecisionFlow } from "./useAnswerDecision";

/**
 * The page of one "Needs you" entry (/decisions/<key>). A decision is the shared card: a low-risk choice
 * answers in one tap, a risky one arms and waits for "Confirm". Once answered the page is its receipt.
 * An approval, a proposal or a stalled run is not answered here: the page says where it is.
 */
export function DecisionDetail({ id, initialChoice = "" }: { id: string; initialChoice?: string }) {
  const q = useQuery({
    queryKey: ["work", "decision", id],
    queryFn: () => api.get<{ entry: DecisionEntry }>(`/api/work/decisions/${encodeURIComponent(id)}`),
    retry: false,
  });
  // The page is about this one decision: its receipt stays after Undo has expired.
  const { flow, shared } = useDecisionFlow({ keepReceipts: true });
  const now = useNow();
  const e = q.data?.entry;
  const view = e ? viewOfEntry(e) : null;
  // Answered here: the entry is gone from the inbox (a refetch says "not found"), the receipt is what is left.
  const receipt = Object.values(flow.receipts)[0];
  const conversation = e ? (e.sessionId ?? e.coordinatorSessionId) : null;
  return (
    <Page width="narrow">
      {/* An open decision is the sheet itself: its title bar is the page's heading and its way back. */}
      {e && view && !receipt ? null : (
        <PageHeader
          title="Decision"
          eyebrow={
            <ButtonLink href="/decisions" variant="ghost" size="sm">
              Needs you
            </ButtonLink>
          }
        />
      )}
      {receipt ? (
        <div className="dcs-stack">
          <DecisionReceiptLine
            receipt={receipt}
            onUndo={() => {
              void flow.undo(receipt.view.ref);
            }}
          />
          <p className="text-sm text-muted">Your answer is on the item. Nothing was settled or sent to a conversation.</p>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/areas?item=${encodeURIComponent(receipt.view.itemId)}`} size="sm">
              Open item
            </ButtonLink>
            <ButtonLink href="/decisions" size="sm" variant="ghost">
              Back to Needs you
            </ButtonLink>
          </div>
        </div>
      ) : (
        <>
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
          {e && view ? (
            <div className="dcs-stack">
              <DecisionCard
                key={view.ref}
                view={view}
                flow={flow}
                now={now}
                arm={initialChoice}
                barAs="h1"
                heading="h2"
                backHref="/decisions"
                closeLabel="Back to Needs you"
              />
              <div className="flex flex-wrap gap-2">
                <ButtonLink href={e.href} size="sm">
                  Open item
                </ButtonLink>
                {conversation ? (
                  <ButtonLink href={`/chat/${encodeURIComponent(conversation)}`} size="sm" variant="ghost">
                    Open conversation
                  </ButtonLink>
                ) : null}
              </div>
            </div>
          ) : null}
          {e && !view ? (
            <Card>
              <section className="min-w-0 space-y-3" aria-labelledby="decision-question">
                <p className="text-xs text-muted">
                  {e.areaTitle ? `${e.areaTitle} › ` : ""}
                  {e.title}
                </p>
                <h2 id="decision-question" className="text-lg font-semibold wrap-anywhere">
                  {e.question}
                </h2>
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
                <p className="text-sm text-muted">
                  Review and confirm in the linked {e.kind === "approval" ? "conversation" : e.kind === "item" ? "item" : "context"}. Nothing is applied from
                  this page.
                </p>
              </section>
            </Card>
          ) : null}
        </>
      )}
      {!shared ? <DecisionNotices notices={flow.notices} /> : null}
    </Page>
  );
}
