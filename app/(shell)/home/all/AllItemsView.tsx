"use client";

import Link from "next/link";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { AttentionBucket, HomeItemsPage } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { ActionCard } from "@/components/actions/ActionCard";
import { Button, Empty, ErrorNote, PageHeader, Spinner, cx } from "@/components/ui";

const TABS: { id: AttentionBucket; label: string; hint: string }[] = [
  { id: "now", label: "Now", hint: "Up to three things that need you first. Safety alerts are always here." },
  { id: "today", label: "Later today", hint: "The next few for today, within the daily limit." },
  { id: "upcoming", label: "Next two weeks", hint: "Dated items in the next 14 days, soonest first." },
  {
    id: "backlog",
    label: "Backlog",
    hint: "Older overdue, undated, later dates, anything over today’s limit and categories you turned down. Ranked the same way; nothing is deleted.",
  },
];

const PAGE = 25;

/** Every open item in one Home bucket, ranked exactly like Home, with an honest total. */
export function AllItemsView({ initial }: { initial: AttentionBucket }) {
  const [bucket, setBucket] = useState<AttentionBucket>(initial);
  const q = useInfiniteQuery({
    queryKey: ["home", "items", bucket],
    queryFn: ({ pageParam }) => api.get<HomeItemsPage>(`/api/home/items?bucket=${bucket}&offset=${pageParam}&limit=${PAGE}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total;
  const tab = TABS.find((t) => t.id === bucket)!;

  return (
    <div className="mx-auto w-full max-w-[880px] px-4 pt-4 pb-6 sm:px-6 dense:px-7 dense:pt-5">
      <PageHeader
        title="All of Home"
        subtitle={
          <Link href="/home" className="hover:underline">
            ← Back to Home
          </Link>
        }
      />
      <div role="group" aria-label="Home section" className="mb-3 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={bucket === t.id}
            aria-controls="all-items"
            onClick={() => {
              setBucket(t.id);
              window.history.replaceState(null, "", `/home/all?bucket=${t.id}`);
            }}
            className={cx(
              "press min-h-11 rounded-full border px-3 text-sm font-medium",
              bucket === t.id ? "border-accent bg-accent-soft text-accent" : "border-line text-text hover:bg-surface-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <section id="all-items" aria-label={tab.label}>
        <p className="mb-3 text-sm text-muted">
          {tab.hint}
          {total !== undefined ? <span data-dynamic> {total === 1 ? "1 item." : `${total} items.`}</span> : null}
        </p>
        {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
        {q.isPending ? (
          <Spinner label="Loading…" />
        ) : items.length ? (
          <ol className="space-y-2">
            {items.map((a) => (
              <li key={a.id}>
                <ActionCard action={a} explain />
              </li>
            ))}
          </ol>
        ) : (
          <Empty title="Nothing here">This part of Home is empty right now.</Empty>
        )}
        {q.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button onClick={() => q.fetchNextPage()} busy={q.isFetchingNextPage}>
              Show more ({items.length} of {total})
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
