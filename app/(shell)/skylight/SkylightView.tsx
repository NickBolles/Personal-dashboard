"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarEvent, NextAction } from "@/lib/contracts";
import { api } from "@/lib/client/api";
import { calendarDay, localDate } from "@/lib/time";
import { useAccess } from "@/components/access";
import { useSource } from "@/components/useSource";
import { SourceState } from "@/components/SourceState";
import { formatWhen } from "@/components/actions/format";
import { Button, ButtonLink, PageHeader, Spinner, useNow, useOnline } from "@/components/ui";
import { SectionHeader, Segmented } from "@/components/ui/kit";
import { useSkylightWrite } from "@/components/skylight/useSkylightWrite";
import { SkylightActionRow } from "@/components/skylight/SkylightActionRow";
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
  const today = localDate(now, timezone);
  const events = [...(q.data?.data?.events ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const all = (q.data?.data?.actions ?? []).filter((a) => whose === "everyone" || a.assignee?.kind !== "other");
  const chores = all.filter((a) => a.status === "open");
  const done = all.filter((a) => a.status === "completed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const dueToday = (action: NextAction) => {
    if (action.priorityReason === "today") return true;
    if (!action.dueAt) return false;
    const day = calendarDay(action.dueAt, action.dueTimezone ?? timezone);
    return day === today;
  };
  const groups = [
    { id: "sk-overdue", label: "Overdue", items: chores.filter((a) => a.priorityReason === "overdue") },
    {
      id: "sk-today",
      label: "Today",
      items: chores.filter((a) => a.priorityReason !== "overdue" && dueToday(a)),
    },
    {
      id: "sk-upcoming",
      label: "Next 7 days",
      items: chores.filter((a) => a.priorityReason !== "overdue" && !dueToday(a)),
    },
    { id: "sk-done", label: "Done this week", items: done },
  ];
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
          {groups.map((group) => {
            const items = group.id === "sk-done" ? group.items : [...group.items].sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
            return (
              <section key={group.id} aria-labelledby={group.id} className="mt-4">
                <SectionHeader id={group.id} label={group.label} count={items.length} />
                {items.length ? (
                  <ul className="jv-feed" data-testid={group.id === "sk-done" ? "skylight-done" : undefined}>
                    {items.map((action) => (
                      // Wrap only when the row can't fit (320 px at 200% text: checkbox + Claim/Reopen + ⋯).
                      <li key={action.id} className="[&>.jv-trow]:flex-wrap">
                        <SkylightActionRow action={action} writable={writable} request={write.request} management />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">{group.id === "sk-done" ? "No completed chores this week." : "No open chores."}</p>
                )}
              </section>
            );
          })}
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
            {!extra.lists?.length ? <p className="text-sm text-muted">No lists.</p> : null}
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
              <p className="text-sm text-muted">No events this week.</p>
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
