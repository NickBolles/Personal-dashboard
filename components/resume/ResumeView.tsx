"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AreasIcon } from "@/components/icons";
import { ErrorNote, Page, Spinner } from "@/components/ui";
import { ButtonLink, Dot, EmptyState, Pill, SectionHeader, Segmented } from "@/components/ui/kit";
import { api } from "@/lib/client/api";
import type { ResumeResponse, ResumeRow } from "@/lib/resume";
import { relativeTime } from "@/lib/time";

export function useResume(enabled = true) {
  return useQuery({
    queryKey: ["work", "resume"],
    queryFn: () => api.get<ResumeResponse>("/api/work/resume"),
    enabled,
    refetchInterval: (query) => (query.state.data?.updating ? 5_000 : 30_000),
  });
}

export function ResumeDot({ row }: { row: ResumeRow }) {
  if (row.kind === "conversation") return <Dot tone={row.unread ? "ac" : "neutral"} label={row.unread ? "Unread" : "Conversation"} />;
  return (
    <Dot
      tone={row.live === "waiting" || row.stalled ? "wn" : row.live === "failed" ? "bad" : row.live === "running" ? "ai" : "neutral"}
      live={row.live === "running" && !row.stalled}
      label={
        row.stalled
          ? "Stalled"
          : row.live === "waiting"
            ? "Waiting for you"
            : row.live === "running"
              ? "Running"
              : row.live === "failed"
                ? "Failed"
                : "Finished"
      }
    />
  );
}

const VIEWS = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "unread", label: "Unread" },
  { value: "unfiled", label: "Unfiled" },
] as const;
type View = (typeof VIEWS)[number]["value"];

function ResumeList({ rows }: { rows: ResumeRow[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {rows.map((row) => (
        <li key={row.key} data-testid="resume-row" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1">
          <ResumeDot row={row} />
          <div className="min-w-0 flex-1 basis-40">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="min-w-0 break-words font-medium">{row.title}</span>
              {row.kind === "run" && row.stalled ? <Pill tone="wn">Stalled</Pill> : null}
              {row.kind === "conversation" && row.unread && row.unreadCount != null && row.unreadCount > 0 ? (
                <span className="text-xs text-accent">{row.unreadCount} unread</span>
              ) : null}
              {row.kind === "conversation" && row.agentProfile ? (
                <Pill tone="ai" className="min-w-0 max-w-full break-words">
                  @{row.agentProfile}
                </Pill>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted">
              {row.path ? (
                row.kind === "conversation" && row.itemHref ? (
                  <Link href={row.itemHref} className="inline-flex min-h-11 min-w-0 max-w-full items-center hover:text-text sm:min-h-6" title={row.path}>
                    <span className="truncate">{row.path}</span>
                  </Link>
                ) : (
                  <span className="max-w-full truncate" title={row.path}>
                    {row.path}
                  </span>
                )
              ) : null}
              {row.kind === "run" ? (
                <>
                  <span>{row.live === "waiting" ? "Waiting for you" : row.live === "running" ? "Running" : row.live === "failed" ? "Failed" : "Finished"}</span>
                  {row.who ? <span className="min-w-0 break-words">{row.who}</span> : null}
                </>
              ) : null}
              {row.at ? (
                <time dateTime={row.at} data-dynamic>
                  {relativeTime(row.at)}
                </time>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <ButtonLink href={row.href} size="sm" className="min-h-11 sm:min-h-9">
              Resume
            </ButtonLink>
            {row.kind === "run" ? (
              <Link
                href={row.itemHref}
                aria-label="Open item"
                title="Open item"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text sm:min-h-10 sm:min-w-10"
              >
                <AreasIcon className="h-4 w-4" />
              </Link>
            ) : row.unfiled ? (
              <Link href="/inbox" className="inline-flex min-h-11 items-center px-2 text-sm text-accent hover:underline sm:min-h-10">
                File…
              </Link>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ResumeView() {
  const q = useResume();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view: View = VIEWS.find((v) => v.value === params.get("view"))?.value ?? "all";
  const data = q.data;
  const runs = data?.runs.filter((r) => view === "all" || (view === "running" && r.live === "running")) ?? [];
  const conversations =
    data?.conversations.filter(
      (c) => !data.conversationsUnavailable && (view === "all" || (view === "unread" && c.unread) || (view === "unfiled" && c.unfiled)),
    ) ?? [];
  const filed = conversations.filter((c) => !c.unfiled);
  const unfiled = conversations.filter((c) => c.unfiled);
  const empty = !!data && !runs.length && !conversations.length;
  const globallyEmpty = !!data && !data.runs.length && !data.conversations.length;

  return (
    <Page width="narrow">
      <header className="mb-3 flex min-w-0 flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="eyebrow">Resume hub</p>
          <h1 className="text-xl leading-tight font-semibold tracking-tight">In flight</h1>
        </div>
      </header>
      <div className="mb-3 min-w-0 [&_.k-seg]:max-w-full [&_.k-seg]:flex-wrap [&_.k-seg-i]:min-h-11 [&_.k-seg-i]:text-sm sm:[&_.k-seg-i]:min-h-10">
        <Segmented
          label="In flight view"
          options={[...VIEWS]}
          value={view}
          onChange={(next) => {
            const search = new URLSearchParams(params.toString());
            if (next === "all") search.delete("view");
            else search.set("view", next);
            router.replace(`${pathname}${search.size ? `?${search}` : ""}`, { scroll: false });
          }}
        />
      </div>
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {!data && !q.error ? <Spinner label="Loading in flight…" /> : null}
      {data?.updating ? (
        <p className="mb-2 text-xs text-muted" role="status">
          Updating…
        </p>
      ) : null}
      {data?.conversationsUnavailable ? <p className="mb-2 text-xs text-muted">Conversations couldn&apos;t load</p> : null}
      <div className="space-y-3 [&_.k-sh-l]:leading-normal">
        {runs.length ? (
          <section aria-labelledby="resume-runs-h">
            <SectionHeader id="resume-runs-h" label="Needs you / running" count={runs.length} />
            <ResumeList rows={runs} />
          </section>
        ) : null}
        {filed.length ? (
          <section aria-labelledby="resume-conversations-h">
            <SectionHeader id="resume-conversations-h" label="Conversations" count={filed.length} />
            <ResumeList rows={filed} />
          </section>
        ) : null}
        {unfiled.length ? (
          <section aria-labelledby="resume-unfiled-h">
            <SectionHeader id="resume-unfiled-h" label="Unfiled" count={data?.counts.unfiled || undefined} />
            <ResumeList rows={unfiled} />
          </section>
        ) : null}
      </div>
      {empty && !data?.conversationsUnavailable ? (
        globallyEmpty ? (
          <EmptyState
            title="Nothing in flight."
            action={
              <ButtonLink href="/chat" variant="primary">
                New chat
              </ButtonLink>
            }
          >
            New chats and agent runs show up here.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing in this view." />
        )
      ) : null}
    </Page>
  );
}
