"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AssistCard } from "@/lib/contracts";
import { addDays, localDate } from "@/lib/time";
import { api, ApiError } from "@/lib/client/api";
import { Button, ButtonLink, Dialog, Field, cx, inputCls, useOnline, useToast } from "@/components/ui";
import { chatHref } from "./chat";
import { splitGlyph } from "@/components/actions/ActionCard";

type Item = NonNullable<AssistCard["triage"]>["items"][number];
type Result = { state: "pending" | "ok" | "unverified"; message?: string };

function dateChoices(today: string) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const saturday = today ? addDays(today, (6 - dow + 7) % 7 || 7) : "";
  const monday = today ? addDays(today, (1 - dow + 7) % 7 || 7) : "";
  return {
    today,
    fmt,
    options: today
      ? [
          { label: "Tomorrow", date: addDays(today, 1) },
          { label: "Saturday", date: saturday },
          { label: "Next Monday", date: monday },
          { label: "In 2 weeks", date: addDays(today, 14) },
        ]
      : [],
  };
}

/**
 * Overdue triage with explicit consent: the person ticks tasks, picks a date,
 * then confirms. Each task goes through POST /api/actions (snooze), which only
 * reports success after the todo provider reads the new date back.
 */
export function TriageDialog({
  open,
  onClose,
  items,
  chat,
  timezone,
}: {
  open: boolean;
  onClose: () => void;
  items: Item[];
  chat?: AssistCard["chat"];
  timezone?: string;
}) {
  const online = useOnline();
  const qc = useQueryClient();
  const { toast, announce } = useToast();
  const [now, setNow] = useState(Date.now);
  // Settings supplies the same household timezone used by the todo adapters.
  // Never fall back to the device timezone while settings are unavailable.
  const today = timezone ? localDate(now, timezone) : "";
  const choices = dateChoices(today);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [date, setDate] = useState("");
  const [step, setStep] = useState<"select" | "confirm" | "run">("select");
  const [results, setResults] = useState<Record<string, Result>>({});

  const close = () => {
    if (step === "run" && Object.values(results).some((r) => r.state === "pending")) return;
    setStep("select");
    setResults({});
    setSelected(new Set());
    setDate("");
    onClose();
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = items.filter((i) => selected.has(i.id));

  const validDate = !!today && /^\d{4}-\d{2}-\d{2}$/.test(date) && date > today;
  function validateCurrentDate() {
    const at = Date.now();
    setNow(at);
    if (!timezone || !validDate || date <= localDate(at, timezone)) {
      setStep("select");
      toast("Choose a future date in the household timezone.", "warn");
      return false;
    }
    return true;
  }

  async function run() {
    if (!online || !validateCurrentDate()) return;
    setStep("run");
    setResults(Object.fromEntries(chosen.map((i) => [i.id, { state: "pending" } as Result])));
    let ok = 0;
    for (const i of chosen) {
      try {
        const result = await api.post<{ ok?: boolean } | undefined>("/api/actions", { actionId: i.id, kind: "snooze", until: date });
        if (result?.ok !== true) throw new Error("No confirmation received");
        ok++;
        setResults((r) => ({ ...r, [i.id]: { state: "ok" } }));
      } catch (err) {
        // A timeout, readback failure, or lost response cannot prove the write did not happen.
        setResults((r) => ({ ...r, [i.id]: { state: "unverified", message: err instanceof ApiError ? err.message : "No confirmation received" } }));
      }
    }
    const msg =
      ok === chosen.length
        ? `Moved ${ok} ${ok === 1 ? "task" : "tasks"} to ${choices.fmt(date)}`
        : `Verified ${ok} of ${chosen.length}; ${chosen.length - ok} unverified — may have changed`;
    toast(msg, ok === chosen.length ? "ok" : "warn");
    announce(msg);
    qc.invalidateQueries({ queryKey: ["home"] });
    qc.invalidateQueries({ queryKey: ["source"] });
  }

  const running = Object.values(results).some((r) => r.state === "pending");
  const unverified = Object.values(results).some((r) => r.state === "unverified");

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={step === "select" ? "Reschedule overdue tasks" : step === "confirm" ? "Confirm new due date" : "Rescheduling"}
      description={
        step === "select"
          ? "Pick the tasks to move and a new date. Nothing changes until you confirm. Tasks you don’t pick stay as they are."
          : step === "confirm"
            ? `Move ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"} to ${choices.fmt(date)}? Each one is changed in your todo list and read back before it counts.`
            : undefined
      }
      footer={
        step === "select" ? (
          <>
            {chat ? (
              <ButtonLink href={chatHref(chat)} variant="ghost" className="min-h-11 text-sm">
                {chat.label} instead
              </ButtonLink>
            ) : null}
            <Button
              variant="primary"
              disabled={!chosen.length || !validDate}
              onClick={() => {
                if (validateCurrentDate()) setStep("confirm");
              }}
            >
              Review {chosen.length || ""} {chosen.length === 1 ? "change" : "changes"}
            </Button>
          </>
        ) : step === "confirm" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("select")}>
              Back
            </Button>
            <Button variant="primary" disabled={!online || !timezone} title={!online ? "Unavailable offline" : undefined} onClick={run}>
              Confirm and reschedule
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={running} onClick={close}>
            {running ? "Working…" : "Close"}
          </Button>
        )
      }
    >
      {step === "select" ? (
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 flex w-full items-center justify-between gap-2 text-sm font-medium">
              <span>
                Overdue tasks <span className="text-muted">({items.length})</span>
              </span>
              <button
                type="button"
                className="tap rounded-[8px] px-2 text-sm text-accent hover:underline"
                onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}
              >
                {selected.size === items.length ? "Select none" : "Select all"}
              </button>
            </legend>
            <ul className="max-h-[40dvh] divide-y divide-line overflow-y-auto rounded-[10px] border border-line">
              {items.map((i) => (
                <li key={i.id}>
                  <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                      aria-label={i.title}
                      aria-describedby={`due-${i.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
                      checked={selected.has(i.id)}
                      onChange={() => toggle(i.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{splitGlyph(i.title).text}</span>
                      <span id={`due-${i.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`} className="text-xs text-muted">
                        Was due {choices.fmt(i.due)}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">New due date</legend>
            <p className="mb-2 text-xs text-muted">
              {timezone ? `Dates use household timezone: ${timezone}.` : "Household timezone unavailable. Refresh Home before rescheduling."}
            </p>
            <div className="mb-2 flex flex-wrap gap-2">
              {choices.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={date === o.date}
                  onClick={() => setDate(o.date)}
                  className={cx(
                    "press min-h-11 rounded-full border px-3 text-sm",
                    date === o.date ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <Field id="triage-date" label="Or pick a date">
              <input
                id="triage-date"
                type="date"
                className={inputCls}
                disabled={!timezone}
                min={today ? addDays(today, 1) : undefined}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </fieldset>
        </div>
      ) : step === "confirm" ? (
        <ul className="max-h-[40dvh] space-y-1 overflow-y-auto text-sm">
          {chosen.map((i) => (
            <li key={i.id} className="truncate">
              · {i.title}{" "}
              <span className="text-muted">
                ({choices.fmt(i.due)} → {choices.fmt(date)})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {unverified && !running ? (
            <p className="mb-3 text-sm text-muted">
              Check your todo list before trying again. A write may have succeeded even when its confirmation was lost. No changes will be retried
              automatically.{" "}
              <ButtonLink href="/todos" variant="ghost">
                Check todo list
              </ButtonLink>
            </p>
          ) : null}
          <ul className="max-h-[40dvh] space-y-1 overflow-y-auto text-sm" aria-live="polite">
            {chosen.map((i) => {
              const r = results[i.id];
              return (
                <li key={i.id} className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className={cx("w-4 shrink-0", r?.state === "ok" ? "jv-check text-ok" : r?.state === "unverified" ? "text-danger" : "text-muted")}
                  >
                    {r?.state === "ok" ? "✓" : r?.state === "unverified" ? "!" : "…"}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{splitGlyph(i.title).text}</span>
                    <span className={cx("text-xs", r?.state === "unverified" ? "text-danger" : "text-muted")}>
                      {r?.state === "ok"
                        ? `Now due ${choices.fmt(date)}`
                        : r?.state === "unverified"
                          ? `Unverified — may have changed: ${r.message}`
                          : "Waiting for readback…"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Dialog>
  );
}
