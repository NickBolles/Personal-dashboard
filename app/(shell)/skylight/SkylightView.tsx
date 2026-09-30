"use client";

import { useSource } from "@/components/useSource";
import { SourceState } from "@/components/SourceState";
import { ActionCard } from "@/components/actions/ActionCard";
import { formatWhen } from "@/components/actions/format";
import { ButtonLink, PageHeader, Spinner } from "@/components/ui";

export function SkylightView() {
  const q = useSource("skylight");
  const events = [...(q.data?.data?.events ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const chores = q.data?.data?.actions ?? [];
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Skylight"
        subtitle="Read-only. Edit events and chores in Skylight."
        actions={
          <ButtonLink href="https://app.ourskylight.com/" external>
            Open Skylight
          </ButtonLink>
        }
      />
      {q.isLoading ? <Spinner label="Loading Skylight…" /> : null}
      <SourceState status={q.data?.status} hasData={Boolean(q.data?.data)} />
      {q.data?.data ? (
        <>
          <section aria-labelledby="sk-chores" className="mt-4">
            <h2 id="sk-chores" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              Today’s chores
            </h2>
            {chores.length ? (
              <ul className="space-y-2">
                {chores.map((a) => (
                  <li key={a.id}>
                    <ActionCard action={a} compact />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No open chores today.</p>
            )}
          </section>
          <section aria-labelledby="sk-events" className="mt-6">
            <h2 id="sk-events" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
              Next 7 days
            </h2>
            {events.length ? (
              <ul className="card divide-y divide-line">
                {events.map((e) => (
                  <li key={e.id} className="p-3">
                    <p className="font-medium">{e.title}</p>
                    <p className="text-sm text-muted">
                      {formatWhen(e.startsAt, e.allDay)}
                      {e.location ? ` · ${e.location}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No events this week.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
