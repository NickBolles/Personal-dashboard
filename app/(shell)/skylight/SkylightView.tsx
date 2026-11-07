"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarEvent } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import { useSource } from "@/components/useSource";
import { SourceState } from "@/components/SourceState";
import { formatWhen } from "@/components/actions/format";
import { Button, ButtonLink, PageHeader, Spinner, useNow, useOnline } from "@/components/ui";
import { EmptyState, SectionHeader, Segmented } from "@/components/ui/kit";
import { useSkylightWrite } from "@/components/skylight/useSkylightWrite";
import { SkylightActionRow } from "@/components/skylight/SkylightActionRow";
import { groupSkylightChores } from "@/components/skylight/grouping";
import { SkylightChoreGroups, useOptimisticChores } from "@/components/skylight/SkylightChoreGroups";
import { SkylightListCard } from "@/components/skylight/SkylightListCard";
import { EventForm } from "@/components/skylight/EventForm";
import { previousEvent } from "@/components/skylight/eventFields";
import type { SkylightExtra } from "@/components/skylight/model";

export function SkylightView() {
  const q = useSource("skylight");
  const { can } = useAccess();
  const online = useOnline();
  const now = useNow();
  const write = useSkylightWrite();
  const extra = (q.data?.data?.extra ?? {}) as SkylightExtra;
  const writable = extra.writable === true && can("skylight.write");
  const [chosenWhose, setWhose] = useState<"mine" | "everyone" | null>(null);
  const whose = chosenWhose ?? (extra.needsMember ? "everyone" : "mine");
  const [form, setForm] = useState<{ event?: CalendarEvent } | null>(null);
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: () => api.get<{ timezone: string }>("/api/settings") });
  const timezone = prefs.data?.timezone || "America/Chicago";
  const events = [...(q.data?.data?.events ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const raw = q.data?.data?.actions;
  const all = useMemo(() => (raw ?? []).filter((a) => whose === "everyone" || a.assignee?.kind !== "other"), [raw, whose]);
  // Optimistic overlay (shared with the tray card): a just-completed chore leaves its group and enters Done at once.
  const optimistic = useOptimisticChores(all, timezone).actions;
  const done = optimistic.filter((a) => a.status === "completed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Skylight's order: today by time of day, then later days, Overdue (past days) at the bottom.
  const choreGroups = groupSkylightChores(optimistic, { now, timezone });
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Skylight"
        subtitle={writable ? "Changes are confirmed and can be undone." : "Read-only. Edit events and chores in Skylight."}
        actions={
          <ButtonLink href="https://app.ourskylight.com/" external>
            Open Skylight
          </ButtonLink>
        }
      />
      {q.isLoading ? <Spinner label="Loading Skylight…" /> : null}
      <SourceState status={q.data?.status} hasData={Boolean(q.data?.data)} />
      {extra.needsMember ? (
        <div role="note" className="card mt-3 flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-sm">
          <span>Showing everyone’s chores. Pick which Skylight member is you to see just yours and up-for-grabs.</span>
          <ButtonLink href="/settings/connections" size="sm">
            Pick your member
          </ButtonLink>
        </div>
      ) : null}
      {q.data?.data ? (
        <>
          {extra.health?.ok === false ? (
            <p role="alert" className="mb-3 rounded-[var(--radius)] border border-warn bg-warn-soft p-3 text-sm text-warn">
              Skylight didn&apos;t return {extra.health.failed.join(", ")} on the last sync — showing what it last returned.
            </p>
          ) : null}
          <Segmented
            label="Whose chores"
            value={whose}
            onChange={setWhose}
            options={[
              { value: "mine", label: "Mine" },
              { value: "everyone", label: "Everyone" },
            ]}
          />
          {!choreGroups.length && !done.length ? <EmptyState title="No open chores." /> : null}
          {/* Morning … Overdue with progress; rows complete in place (same row + motion as Today and the tray). */}
          <div className="mt-4">
            <SkylightChoreGroups actions={all} writable={writable} request={write.request} timezone={timezone} now={now} idPrefix="sk" level={2} />
          </div>
          <section aria-labelledby="sk-done" className="mt-4">
            <SectionHeader id="sk-done" label="Done this week" count={done.length} />
            {done.length ? (
              <ul className="jv-feed" data-testid="skylight-done">
                {done.map((action) => (
                  <li key={action.id}>
                    <SkylightActionRow action={action} writable={writable} request={write.request} timezone={timezone} management />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No completed chores this week." />
            )}
          </section>
          <section aria-labelledby="sk-lists" className="mt-6">
            <SectionHeader id="sk-lists" label="Lists" />
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {(extra.lists ?? []).map((list) => (
                <SkylightListCard
                  key={list.id}
                  list={list}
                  items={(extra.listItems ?? []).filter((item) => item.skylight?.kind === "list_item" && item.skylight.listId === list.id)}
                  writable={writable}
                  request={write.request}
                />
              ))}
            </div>
            {!extra.lists?.length ? <EmptyState title="No lists." /> : null}
          </section>
          <section aria-labelledby="sk-events" className="mt-6">
            <SectionHeader
              id="sk-events"
              label="Events · next 7 days"
              action={
                writable ? (
                  <Button type="button" size="sm" disabled={!online} onClick={() => setForm({})}>
                    New event
                  </Button>
                ) : undefined
              }
            />
            {events.length ? (
              <ul className="card divide-y divide-line">
                {events.map((e) => (
                  <li key={e.id} className="p-3">
                    <p className="font-medium">{e.title}</p>
                    <p className="text-sm text-muted">
                      {formatWhen(e.startsAt, e.allDay)}
                      {e.location ? ` · ${e.location}` : ""}
                    </p>
                    {writable && e.skylight?.editable ? (
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Button type="button" size="sm" disabled={!online} aria-label={`Edit ${e.title}`} onClick={() => setForm({ event: e })}>
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={!online}
                          aria-label={`Delete ${e.title}`}
                          onClick={() => write.request({ op: "event.delete", eventId: e.skylight!.eventId, previous: previousEvent(e) })}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No events this week." />
            )}
          </section>
        </>
      ) : null}
      {form && writable ? (
        <EventForm
          event={form.event}
          timezone={timezone}
          onClose={() => setForm(null)}
          onSubmit={(op) => {
            setForm(null);
            // Let the form restore its opener before the confirm dialog captures focus.
            requestAnimationFrame(() => write.request(op));
          }}
        />
      ) : null}
      {write.node}
    </div>
  );
}
