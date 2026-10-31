"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HOME_SECTIONS, type AttentionSummary, type HomePayload, type HomeSectionId, type NextAction, type SourceStatus } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { kvGet, kvSet } from "@/lib/client/idb";
import { ActionCard } from "@/components/actions/ActionCard";
import { formatWhen } from "@/components/actions/format";
import { AssistCard } from "@/components/home/AssistCard";
import { TriageDialog } from "@/components/home/TriageDialog";
import type { AssistCard as Assist } from "@/lib/contracts";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { Badge, Empty, ErrorNote, OverflowMenu, Page, SectionLabel, Spinner, cx, useOnline } from "@/components/ui";
import { useRouter } from "next/navigation";
import { ChevronIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { Skeleton } from "@/components/ui/kit";
import { sparkPoints, sum, type HomePulse, type PulseTrend } from "@/lib/pulse";

const PROBLEM: SourceStatus["state"][] = ["stale", "error", "unauthorized", "refreshing"];

function FreshnessStrip({ sources, refreshing, online, generatedAt }: { sources: SourceStatus[]; refreshing: boolean; online: boolean; generatedAt?: string }) {
  const problems = sources.filter((s) => PROBLEM.includes(s.state));
  if (online && !refreshing && !problems.length) return null; // never a permanent "all good" banner
  return (
    <div role="status" className="mb-4 flex flex-col gap-1 rounded-[10px] border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
      {!online ? <p>Offline — showing data from {generatedAt ? relativeTime(generatedAt) : "your last visit"}.</p> : null}
      {refreshing && online ? (
        <p className="flex items-center gap-2">
          <Spinner /> Refreshing sources…
        </p>
      ) : null}
      {problems.map((s) => (
        <p key={s.source}>
          <strong className="font-semibold">{s.label}:</strong>{" "}
          {s.state === "unauthorized" ? (
            <>
              needs re-authentication.{" "}
              <Link className="underline" href="/settings/connections">
                Fix connection
              </Link>
            </>
          ) : s.state === "error" ? (
            <>
              couldn’t refresh{s.fetchedAt ? ` (showing data from ${relativeTime(s.fetchedAt)})` : " — nothing cached yet"}.{" "}
              {s.error ? <span className="opacity-80">{s.error}</span> : null}
            </>
          ) : s.state === "stale" ? (
            <>data from {s.fetchedAt ? relativeTime(s.fetchedAt) : "earlier"}</>
          ) : (
            <>loading…</>
          )}
        </p>
      ))}
    </div>
  );
}

function SectionTitle({ id, children, count, action }: { id: string; children: string; count?: string; action?: React.ReactNode }) {
  return (
    <SectionLabel id={id} count={count} action={action}>
      {children}
    </SectionLabel>
  );
}

function SeeAll({ bucket, total, label }: { bucket: string; total: number; label: string }) {
  return (
    <Link
      href={`/home/all?bucket=${bucket}`}
      className="tap inline-flex items-center gap-0.5 rounded-[8px] px-1 text-xs font-semibold text-accent hover:underline dense:min-h-6"
    >
      See all {total}
      <span className="sr-only"> {label}</span>
      <ChevronIcon className="h-4 w-4" />
    </Link>
  );
}

/** "3 for now · 5 today · 37 more tracked", plus today's Compass focus when there is one. */
function AttentionLine({ a }: { a: AttentionSummary }) {
  const t = a.totals;
  const more = t.upcoming + t.backlog;
  const c = a.compass;
  return (
    <div className="mt-1 space-y-1">
      <p className="text-sm text-muted" data-dynamic>
        {t.open === 0
          ? "Nothing open right now."
          : `${t.now} for now${t.today ? ` · ${t.today} later today` : ""}${more ? ` · ${more} more tracked` : ""}${t.snoozed ? ` · ${t.snoozed} hidden for now` : ""}`}
      </p>
      {c?.state === "focus" ? (
        <p className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium text-[var(--tier-compass)]">Compass focus</span>
          {c.focus.map((f) => (
            <span key={f} className="rounded-[6px] border border-line bg-surface px-1.5 text-xs leading-5">
              {f}
            </span>
          ))}
          {c.stale ? <span className="text-xs text-warn">(may be out of date)</span> : null}
        </p>
      ) : c?.state === "unavailable" || c?.state === "outdated" ? (
        <p className="text-xs text-muted">Daily Compass focus isn’t available right now, so it isn’t used for ranking.</p>
      ) : null}
    </div>
  );
}

function LaterGroup({ id, title, items }: { id: string; title: string; items: NextAction[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <li className="card">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left text-[0.875rem] font-medium dense:min-h-10"
        >
          <span>
            {title} <span className="text-muted">({items.length})</span>
          </span>
          <ChevronIcon className={cx("h-4 w-4 text-muted transition-transform", open && "rotate-90")} />
        </button>
      </h3>
      {open ? (
        <ul id={id} className="space-y-2 border-t border-line p-2.5">
          {items.map((a) => (
            <li key={a.id}>
              <ActionCard action={a} compact={title === "Recently completed"} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Overdue · Now · Later today · Backlog, then (when the person can see them)
 * Approvals waiting · Awaiting validation · Merged, not settled — one dense
 * strip under the header (design PR4 + design review "Today counts"). Counts
 * the person can't see are hidden, never shown as zero.
 */
function KpiStrip({ a, pulse }: { a: AttentionSummary; pulse?: HomePulse }) {
  const t = a.totals;
  const cell = "flex min-h-11 min-w-0 flex-col justify-center gap-0.5 px-2 py-1.5 sm:min-h-10 sm:px-3";
  const label = "text-[0.625rem] font-semibold [overflow-wrap:anywhere] tracking-[0.04em] text-muted uppercase sm:text-[0.6875rem] sm:tracking-[0.06em]";
  const value = "text-[1.0625rem] leading-6 font-semibold tabular-nums";
  const extra: { key: string; short: string; long: string; n: number | null | undefined; href: string; tone: string }[] = [
    { key: "approvals", short: "Approvals", long: "Approvals waiting", n: pulse?.approvals, href: "/alerts", tone: "text-warn" },
    { key: "validation", short: "Validation", long: "Awaiting validation", n: pulse?.awaitingValidation, href: "/areas#today-proof", tone: "text-warn" },
    { key: "merged", short: "Merged", long: "Merged, not settled", n: pulse?.mergedNotSettled, href: "/areas#today-settle", tone: "text-ok" },
  ];
  return (
    <div className="mb-4 space-y-1.5">
      <dl
        aria-label="Today at a glance"
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,5.75rem),1fr))] divide-x divide-line rounded-[var(--radius)] border border-line bg-surface"
      >
        <div className={cell}>
          <dt className={label}>Overdue</dt>
          <dd className={cx(value, t.overdue ? "text-warn" : undefined)}>{t.overdue}</dd>
        </div>
        <div className={cell}>
          <dt className={label}>Now</dt>
          <dd className={value}>{t.now}</dd>
        </div>
        <div className={cell}>
          <dt className={label}>Later</dt>
          <dd className={value}>{t.today}</dd>
        </div>
        <div className={cell}>
          <dt className={label}>Backlog</dt>
          <dd className={value}>
            <Link href="/home/all?bucket=backlog" className="hover:underline">
              <span className="sr-only">Backlog: </span>
              {t.backlog}
              <span className="sr-only"> items{t.overdue ? `, ${t.overdue} overdue across Home` : ""}</span>
            </Link>
          </dd>
        </div>
        {extra
          .filter((k) => typeof k.n === "number")
          .map((k) => (
            <div key={k.key} className={cell} data-kpi={k.key}>
              <dt className={label} title={k.long}>
                {k.short}
              </dt>
              <dd className={cx(value, k.n ? k.tone : undefined)}>
                <Link href={k.href} className="hover:underline" aria-label={`${k.long}: ${k.n}`}>
                  {k.n}
                </Link>
              </dd>
            </div>
          ))}
      </dl>
      {pulse?.trend ? <TrendLine trend={pulse.trend} /> : null}
    </div>
  );
}

/** Completed vs added over 14 days: a compact two-line sparkline (no gradient — spec keeps gradients to orb/glyph/progress). */
function TrendLine({ trend }: { trend: PulseTrend }) {
  const done = sum(trend.completed);
  const added = sum(trend.added);
  const max = Math.max(1, ...trend.completed, ...trend.added);
  const w = 112;
  const h = 20;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[0.75rem] text-muted" data-testid="today-trend">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0 overflow-visible">
        <polyline
          points={sparkPoints(trend.added, w, h, max)}
          fill="none"
          stroke="var(--color-line-strong, currentColor)"
          strokeWidth="1.25"
          strokeDasharray="2 2"
        />
        <polyline points={sparkPoints(trend.completed, w, h, max)} fill="none" stroke="var(--color-accent, currentColor)" strokeWidth="1.5" />
      </svg>
      <span data-dynamic>
        <span className="font-medium text-text">{done}</span> completed vs <span className="font-medium text-text">{added}</span> added · 14 days
      </span>
    </p>
  );
}

/** Same shape as the loaded page, so nothing jumps when data arrives. */
function HomeSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card space-y-2 px-3.5 py-3 pl-4">
          <Skeleton w={112} h={12} className="block" />
          <Skeleton w="75%" h={16} className="block" />
          <Skeleton w="50%" h={12} className="block" />
        </div>
      ))}
    </div>
  );
}

export function HomeView() {
  // Keep the reviewed selection alive across Home refetches. Successful tasks
  // leave the suggestion (and the whole card may disappear) before Close.
  const [triage, setTriage] = useState<Assist | null>(null);
  const online = useOnline();
  const { can } = useAccess();
  const [snapshot, setSnapshot] = useState<HomePayload>();

  useEffect(() => {
    kvGet<HomePayload>("home:snapshot").then((s) => s && setSnapshot((cur) => cur ?? s));
  }, []);

  const cached = useQuery({
    queryKey: ["home", "cached"],
    queryFn: () => api.get<HomePayload>("/api/home?cached=1"),
    staleTime: Infinity,
  });
  const live = useQuery({
    queryKey: ["home", "live"],
    queryFn: () => api.get<HomePayload>("/api/home"),
    refetchInterval: 60_000,
    enabled: online,
  });

  // Today counts + 14-day trend (local data only, cheap): hidden until loaded, never faked.
  const pulse = useQuery({
    queryKey: ["home", "pulse"],
    queryFn: () => api.get<HomePulse>("/api/home/pulse"),
    refetchInterval: 60_000,
    enabled: online,
  });

  useEffect(() => {
    if (live.data) kvSet("home:snapshot", live.data);
  }, [live.data]);

  const data = live.data ?? cached.data ?? snapshot;
  // Section order/visibility is shared with the phone app (Settings → Home layout there).
  const prefs = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.get<{ timezone: string; layout?: { homeSections: { id: HomeSectionId; visible: boolean }[] } }>("/api/settings"),
  });
  const layout = prefs.data?.layout?.homeSections ?? HOME_SECTIONS.map((s) => ({ id: s.id as HomeSectionId, visible: true }));
  const visible = (id: HomeSectionId) => layout.find((s) => s.id === id)?.visible ?? true;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const att = data?.attention;
  const router = useRouter();

  const later: Partial<Record<HomeSectionId, (d: HomePayload) => React.ReactNode>> = {
    later_today: (d) =>
      d.later.laterToday.length ? (
        <section key="later_today" aria-labelledby="today-h" className="mb-5">
          <SectionTitle id="today-h" count={String(d.later.laterToday.length)}>
            Later today
          </SectionTitle>
          <ol className="jv-feed">
            {d.later.laterToday.map((a) => (
              <li key={a.id} className="jv-rise">
                <ActionCard action={a} explain />
              </li>
            ))}
          </ol>
        </section>
      ) : null,
    upcoming: (d) =>
      d.later.upcoming.length ? (
        <section key="upcoming" aria-labelledby="upcoming-h" className="mb-5">
          <SectionTitle
            id="upcoming-h"
            count={att ? `${d.later.upcoming.length} of ${att.totals.upcoming}` : undefined}
            action={att && att.totals.upcoming > d.later.upcoming.length ? <SeeAll bucket="upcoming" total={att.totals.upcoming} label="upcoming" /> : null}
          >
            Next two weeks
          </SectionTitle>
          <ul className="jv-feed">
            {d.later.upcoming.map((a) => (
              <li key={a.id}>
                <ActionCard action={a} explain />
              </li>
            ))}
          </ul>
        </section>
      ) : null,
  };
  const groups: Partial<Record<HomeSectionId, { id: string; title: string; items: (d: HomePayload) => NextAction[] }>> = {
    waiting: { id: "later-waiting", title: "Waiting on", items: (d) => d.later.waitingOn },
    completed: { id: "later-done", title: "Recently completed", items: (d) => d.later.recentlyCompleted },
  };

  return (
    <Page>
      <header className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="eyebrow" data-dynamic>
            {new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </p>
          <h1 className="mt-0.5 text-[1.375rem] leading-8 font-semibold tracking-[-0.015em]">
            <span className="k-greet">{greeting}</span>
          </h1>
          {att ? <AttentionLine a={att} /> : null}
        </div>
        <OverflowMenu
          label="Today options"
          items={[
            { label: "All of Home", onSelect: () => router.push("/home/all") },
            { label: "Customize Today", onSelect: () => router.push("/settings/home") },
          ]}
        />
      </header>
      {att ? <KpiStrip a={att} pulse={pulse.data} /> : null}

      {data ? <FreshnessStrip sources={data.sources} refreshing={live.isFetching && !live.data} online={online} generatedAt={data.generatedAt} /> : null}
      {live.error && !data ? <ErrorNote error={live.error} retry={() => live.refetch()} /> : null}

      <div className="grid gap-x-6 min-[1100px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {visible("now") ? (
            <section aria-labelledby="now-h" aria-busy={!data || undefined} className="mb-5">
              <SectionTitle id="now-h" count={att && data?.now.length ? `${data.now.length}` : undefined}>
                Now
              </SectionTitle>
              {!data ? (
                <>
                  <span className="sr-only" role="status">
                    Loading your next actions…
                  </span>
                  <HomeSkeleton />
                </>
              ) : data.now.length ? (
                <>
                  <ol className="jv-feed">
                    {data.now.map((a) => (
                      <li key={a.id} className="jv-rise">
                        <ActionCard action={a} explain />
                      </li>
                    ))}
                  </ol>
                  {att?.overBudget ? (
                    <p className="mt-2 text-xs text-muted">
                      {att.overBudget} more safety {att.overBudget === 1 ? "alert" : "alerts"} than the usual {att.budget.now}: safety alerts are always shown.
                    </p>
                  ) : null}
                </>
              ) : data.sources.some((s) => s.state === "ok" || s.state === "stale") ? (
                <Empty title="Nothing needs you right now">
                  Checked{" "}
                  {data.sources
                    .filter((s) => s.state === "ok" || s.state === "stale")
                    .map((s) => s.label)
                    .join(", ")}
                  .
                </Empty>
              ) : (
                <Empty
                  title="No sources connected yet"
                  action={
                    <Link className="underline" href="/settings/connections">
                      Connect sources
                    </Link>
                  }
                >
                  Jarvis can’t tell what’s next until at least one source is connected.
                </Empty>
              )}
            </section>
          ) : null}

          {data?.assists?.length ? (
            <section aria-labelledby="assist-h" className="mb-5">
              <SectionTitle id="assist-h">Suggestions</SectionTitle>
              <ul className="space-y-1.5">
                {data.assists.map((c) => (
                  <li key={c.id}>
                    <AssistCard card={c} onTriage={setTriage} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {triage?.triage ? (
            <TriageDialog open onClose={() => setTriage(null)} items={triage.triage.items} chat={triage.chat} timezone={prefs.data?.timezone} />
          ) : null}

          {can("hermes.chat") || can("work.use") ? (
            <section aria-labelledby="capture-h" className="mb-5">
              <h2 id="capture-h" className="sr-only">
                Quick capture
              </h2>
              <QuickCapture />
            </section>
          ) : null}

          {data
            ? layout
                .filter((s) => s.visible)
                .map((s) => {
                  if (later[s.id]) return later[s.id]!(data);
                  const g = groups[s.id];
                  return g && g.items(data).length ? (
                    <ul key={s.id} className="mb-5 space-y-2">
                      <LaterGroup id={g.id} title={g.title} items={g.items(data)} />
                    </ul>
                  ) : null;
                })
            : null}
        </div>

        {/* Context rail: beside the feed on wide screens, after it on phones. */}
        <aside aria-label="At a glance" className="min-w-0 space-y-5">
          {data && visible("glance") ? <Glance data={data} /> : null}
        </aside>
      </div>
    </Page>
  );
}

function Glance({ data }: { data: HomePayload }) {
  const src = (k: string) => data.sources.find((s) => s.source === k);
  const calendarKnown = ["skylight", "home_assistant"].some((k) => ["ok", "stale"].includes(src(k)?.state ?? ""));
  const ha = src("home_assistant");
  const compass = src("daily_compass");
  return (
    <section aria-labelledby="glance-h">
      <SectionLabel id="glance-h">Household</SectionLabel>
      <ul className="jv-feed jv-glance grid sm:max-[1099px]:grid-cols-3">
        <li className="min-w-0 px-3.5 py-2.5">
          <h3 className="eyebrow">Next event</h3>
          {data.glance.nextEvent ? (
            <>
              <p className="mt-1 font-semibold">{data.glance.nextEvent.title}</p>
              <p className="text-sm text-muted">{formatWhen(data.glance.nextEvent.startsAt, data.glance.nextEvent.allDay)}</p>
            </>
          ) : calendarKnown ? (
            <p className="mt-1 text-sm text-muted">Nothing scheduled this week</p>
          ) : (
            <p className="mt-1 text-sm text-muted">Calendar not connected</p>
          )}
        </li>
        <li className="min-w-0 px-3.5 py-2.5">
          <h3 className="eyebrow">Daily Compass</h3>
          {data.glance.compass ? (
            <p className="mt-1">
              <Link href="/daily-compass" className="font-semibold hover:underline">
                {data.glance.compass.completed
                  ? "Done for today"
                  : data.glance.compass.inWindow
                    ? "Check-in open now"
                    : `Opens ${data.glance.compass.windowLabel.split("–")[0]}`}
              </Link>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">{compass?.state === "error" ? "Couldn’t load" : "Not set up"}</p>
          )}
        </li>
        <li className="min-w-0 px-3.5 py-2.5">
          <h3 className="eyebrow">Home</h3>
          {ha?.state === "ok" || ha?.state === "stale" ? (
            data.glance.homeExceptions.length ? (
              <ul className="mt-1 space-y-1">
                {data.glance.homeExceptions.slice(0, 3).map((e) => (
                  <li key={e.entityId} className="text-sm">
                    <Badge tone={e.severity === "critical" || e.severity === "high" ? "danger" : "warn"}>{e.severity}</Badge>{" "}
                    <Link href={`/home-control?entity=${encodeURIComponent(e.entityId)}`} className="hover:underline">
                      {e.name}: {e.reason}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">No exceptions</p>
            )
          ) : (
            <p className="mt-1 text-sm text-muted">{ha?.state === "error" || ha?.state === "unauthorized" ? "Home state unknown" : "Not connected"}</p>
          )}
        </li>
      </ul>
    </section>
  );
}
