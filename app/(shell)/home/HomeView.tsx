"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HomePayload, NextAction, SourceStatus } from "@/lib/contracts";
import { relativeTime } from "@/lib/time";
import { api } from "@/lib/client/api";
import { kvGet, kvSet } from "@/lib/client/idb";
import { ActionCard } from "@/components/actions/ActionCard";
import { formatWhen } from "@/components/actions/format";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { Badge, Empty, ErrorNote, Spinner, cx, useOnline } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";

const PROBLEM: SourceStatus["state"][] = ["stale", "error", "unauthorized", "refreshing"];

function FreshnessStrip({ sources, refreshing, online, generatedAt }: { sources: SourceStatus[]; refreshing: boolean; online: boolean; generatedAt?: string }) {
  const problems = sources.filter((s) => PROBLEM.includes(s.state));
  if (online && !refreshing && !problems.length) return null; // never a permanent "all good" banner
  return (
    <div role="status" className="card mb-4 flex flex-col gap-1 border-warn bg-warn-soft p-3 text-sm text-warn">
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
              needs re-authentication. <Link className="underline" href="/settings/connections">Fix connection</Link>
            </>
          ) : s.state === "error" ? (
            <>
              couldn’t refresh{s.fetchedAt ? ` (showing data from ${relativeTime(s.fetchedAt)})` : " — nothing cached yet"}. {s.error ? <span className="opacity-80">{s.error}</span> : null}
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
          className="flex min-h-12 w-full items-center justify-between gap-2 px-4 text-left font-medium"
        >
          <span>
            {title} <span className="text-muted">({items.length})</span>
          </span>
          <ChevronIcon className={cx("h-5 w-5 transition-transform", open && "rotate-90")} />
        </button>
      </h3>
      {open ? (
        <ul id={id} className="space-y-2 border-t border-line p-3">
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

export function HomeView() {
  const online = useOnline();
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

  useEffect(() => {
    if (live.data) kvSet("home:snapshot", live.data);
  }, [live.data]);

  const data = live.data ?? cached.data ?? snapshot;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <header className="mb-4">
        <p className="text-sm text-muted">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
      </header>

      {data ? (
        <FreshnessStrip sources={data.sources} refreshing={live.isFetching && !live.data} online={online} generatedAt={data.generatedAt} />
      ) : null}
      {live.error && !data ? <ErrorNote error={live.error} retry={() => live.refetch()} /> : null}

      <section aria-labelledby="now-h" className="mb-6">
        <h2 id="now-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Now
        </h2>
        {!data ? (
          <div className="card p-4">
            <Spinner label="Loading your next actions…" />
          </div>
        ) : data.now.length ? (
          <ol className="space-y-3">
            {data.now.map((a) => (
              <li key={a.id}>
                <ActionCard action={a} />
              </li>
            ))}
          </ol>
        ) : data.sources.some((s) => s.state === "ok" || s.state === "stale") ? (
          <Empty title="Nothing needs you right now">Checked {data.sources.filter((s) => s.state === "ok" || s.state === "stale").map((s) => s.label).join(", ")}.</Empty>
        ) : (
          <Empty title="No sources connected yet" action={<Link className="underline" href="/settings/connections">Connect sources</Link>}>
            Jarvis can’t tell what’s next until at least one source is connected.
          </Empty>
        )}
      </section>

      <section aria-labelledby="capture-h" className="mb-6">
        <h2 id="capture-h" className="sr-only">
          Quick capture
        </h2>
        <QuickCapture />
      </section>

      {data ? (
        <section aria-labelledby="later-h" className="mb-6">
          <h2 id="later-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
            Later
          </h2>
          <ul className="space-y-2">
            <LaterGroup id="later-today" title="Later today" items={data.later.laterToday} />
            <LaterGroup id="later-upcoming" title="Upcoming" items={data.later.upcoming} />
            <LaterGroup id="later-waiting" title="Waiting on" items={data.later.waitingOn} />
            <LaterGroup id="later-done" title="Recently completed" items={data.later.recentlyCompleted} />
          </ul>
          {!data.later.laterToday.length && !data.later.upcoming.length && !data.later.waitingOn.length && !data.later.recentlyCompleted.length ? (
            <p className="text-sm text-muted">Nothing else queued.</p>
          ) : null}
        </section>
      ) : null}

      {data ? <Glance data={data} /> : null}
    </div>
  );
}

function Glance({ data }: { data: HomePayload }) {
  const src = (k: string) => data.sources.find((s) => s.source === k);
  const calendarKnown = ["skylight", "home_assistant"].some((k) => ["ok", "stale"].includes(src(k)?.state ?? ""));
  const ha = src("home_assistant");
  const compass = src("daily_compass");
  return (
    <section aria-labelledby="glance-h">
      <h2 id="glance-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Household
      </h2>
      <ul className="grid gap-2 sm:grid-cols-3">
        <li className="card p-4">
          <h3 className="text-xs font-medium text-muted">Next event</h3>
          {data.glance.nextEvent ? (
            <>
              <p className="mt-1 font-medium">{data.glance.nextEvent.title}</p>
              <p className="text-sm text-muted">{formatWhen(data.glance.nextEvent.startsAt, data.glance.nextEvent.allDay)}</p>
            </>
          ) : calendarKnown ? (
            <p className="mt-1 text-sm text-muted">Nothing scheduled this week</p>
          ) : (
            <p className="mt-1 text-sm text-muted">Calendar not connected</p>
          )}
        </li>
        <li className="card p-4">
          <h3 className="text-xs font-medium text-muted">Daily Compass</h3>
          {data.glance.compass ? (
            <p className="mt-1">
              <Link href="/daily-compass" className="font-medium hover:underline">
                {data.glance.compass.completed ? "Done for today" : data.glance.compass.inWindow ? "Check-in open now" : `Opens ${data.glance.compass.windowLabel.split("–")[0]}`}
              </Link>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">{compass?.state === "error" ? "Couldn’t load" : "Not set up"}</p>
          )}
        </li>
        <li className="card p-4">
          <h3 className="text-xs font-medium text-muted">Home</h3>
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
