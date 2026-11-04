"use client";

import { useId, useState } from "react";
import type { CalendarEvent } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { addDays, localDate } from "@/lib/time";
import { Button, Dialog, Field, inputCls, useOnline } from "@/components/ui";
import { eventInstant, eventTime, previousEvent } from "./eventFields";

export function EventForm({
  event,
  timezone,
  onClose,
  onSubmit,
}: {
  event?: CalendarEvent;
  timezone: string;
  onClose: () => void;
  onSubmit: (op: SkylightWriteOp) => void;
}) {
  const id = useId();
  const online = useOnline();
  const [title, setTitle] = useState(event?.title ?? "");
  const [date, setDate] = useState(() =>
    event ? (event.allDay ? event.startsAt.slice(0, 10) : localDate(new Date(event.startsAt), timezone)) : localDate(new Date(), timezone),
  );
  const [allDay, setAllDay] = useState(Boolean(event?.allDay));
  const [start, setStart] = useState(() => (event && !event.allDay ? eventTime(event.startsAt, timezone) : "09:00"));
  const [end, setEnd] = useState(() => (event?.endsAt && !event.allDay ? eventTime(event.endsAt, timezone) : "10:00"));
  const [endDate, setEndDate] = useState(() => (event && !event.allDay && event.endsAt ? localDate(new Date(event.endsAt), timezone) : ""));
  const [location, setLocation] = useState(event?.location ?? "");
  const [error, setError] = useState("");
  const formId = `${id}-event`;
  return (
    <Dialog
      open
      title={event ? "Edit event" : "New event"}
      onClose={onClose}
      description={`Times use ${timezone}. All-day events end the following day.`}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={!online}>
            Review change
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!online) return;
          if (!title.trim()) {
            setError("Title is required.");
            return;
          }
          if (!date || (!allDay && (!start || !end))) {
            setError("Choose a date and start and end times.");
            return;
          }
          const startsAt = allDay ? date : eventInstant(date, start, timezone);
          const endsAt = allDay ? addDays(date, 1) : eventInstant(endDate || date, end, timezone);
          if (Date.parse(endsAt) <= Date.parse(startsAt)) {
            setError("End must be after start.");
            return;
          }
          const fields = {
            summary: title.trim(),
            allDay,
            startsAt,
            endsAt,
            location: location.trim() || null,
            description: event?.skylight?.description ?? null,
          };
          if (event?.skylight) onSubmit({ op: "event.update", eventId: event.skylight.eventId, event: fields, previous: previousEvent(event) });
          else onSubmit({ op: "event.create", event: fields });
        }}
      >
        <Field id={`${id}-title`} label="Title">
          <input id={`${id}-title`} className={inputCls} value={title} maxLength={500} required onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id={`${id}-date`} label="Date">
          <input
            id={`${id}-date`}
            type="date"
            className={inputCls}
            value={date}
            required
            onChange={(e) => {
              setDate(e.target.value);
              setEndDate("");
            }}
          />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day
        </label>
        {!allDay ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${id}-start`} label="Start">
                <input id={`${id}-start`} type="time" className={`${inputCls} min-w-0`} value={start} required onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field id={`${id}-end`} label="End">
                <input id={`${id}-end`} type="time" className={`${inputCls} min-w-0`} value={end} required onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </div>
            {endDate && endDate !== date ? (
              <Field id={`${id}-end-date`} label="End date">
                <input id={`${id}-end-date`} type="date" className={inputCls} value={endDate} required onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            ) : null}
          </>
        ) : null}
        <Field id={`${id}-location`} label="Location">
          <input id={`${id}-location`} className={inputCls} value={location} maxLength={1000} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
