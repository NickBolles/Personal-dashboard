"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { ATTENTION_VERSION, categoryLabel, type FeedbackVerdict } from "@/lib/attention";
import { Button, Dialog, Field, cx, inputCls, useOnline, useToast } from "@/components/ui";

/** What a person is reacting to, with what the card said (stored as provenance). */
export type FeedbackTarget = {
  kind: "action" | "assist";
  id: string;
  category: string;
  title: string;
  fingerprint: string;
  why: string[];
  sources: string[];
};

type Vars = { target: FeedbackTarget; verdict: FeedbackVerdict; correction?: string; snoozeUntil?: string; key: string };

export function useFeedback() {
  const qc = useQueryClient();
  const { toast, announce } = useToast();
  return useMutation({
    mutationFn: (v: Vars) =>
      api.post<{ message: string }>("/api/home/feedback", {
        idempotencyKey: v.key,
        target: { kind: v.target.kind, id: v.target.id, category: v.target.category },
        verdict: v.verdict,
        correction: v.correction?.trim() || undefined,
        snoozeUntil: v.snoozeUntil,
        provenance: {
          version: ATTENTION_VERSION,
          fingerprint: v.target.fingerprint.slice(0, 128),
          why: v.target.why.slice(0, 6).map((w) => w.slice(0, 200)),
          sources: v.target.sources.slice(0, 8).map((s) => s.slice(0, 40)),
        },
      }),
    onSuccess: (res) => {
      toast(res.message, "ok");
      announce(res.message);
      qc.invalidateQueries({ queryKey: ["home"] });
      qc.invalidateQueries({ queryKey: ["home-tuning"] });
    },
    onError: (err) => toast((err as Error).message, "danger"),
  });
}

function localMorning(now: Date, days: number) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(7, 0, 0, 0);
  return d;
}

/** "Not now" choices, in the browser's local time (computed when tapped, so render stays pure). */
export const HIDE_CHOICES: { label: string; until: (now: Date) => Date }[] = [
  { label: "For 3 hours", until: (now) => new Date(now.getTime() + 3 * 3600_000) },
  { label: "Until tomorrow", until: (now) => localMorning(now, 1) },
  { label: "For a week", until: (now) => localMorning(now, 7) },
];

const chip = "press min-h-11 rounded-full border border-line px-3 text-sm text-text hover:bg-surface-2 disabled:opacity-50";

/**
 * Feedback for one card. Every choice says what it will do; all of it is
 * per person, reversible in Settings → Home priorities, and never changes the
 * item in its source.
 */
export function FeedbackBar({ target, canHide = true, rate = false }: { target: FeedbackTarget; canHide?: boolean; rate?: boolean }) {
  const online = useOnline();
  const fb = useFeedback();
  const [hiding, setHiding] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [correction, setCorrection] = useState("");
  const hideId = useId();
  const send = (verdict: FeedbackVerdict, extra: Partial<Vars> = {}) => fb.mutate({ target, verdict, key: newIdempotencyKey("fb"), ...extra });
  const label = categoryLabel(target.category);
  const disabled = !online || fb.isPending;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Feedback on ${target.title}`}>
        {rate ? (
          <>
            <button type="button" className={chip} disabled={disabled} onClick={() => send("helpful")}>
              Helpful
            </button>
            <button type="button" className={chip} disabled={disabled} onClick={() => send("not_helpful")}>
              Not helpful
            </button>
          </>
        ) : null}
        {canHide ? (
          <button type="button" className={chip} aria-expanded={hiding} aria-controls={hideId} disabled={disabled} onClick={() => setHiding((h) => !h)}>
            Not now
          </button>
        ) : null}
        {canHide ? (
          <button type="button" className={chip} disabled={disabled} onClick={() => send("less_like_this")} title={`Rank ${label} lower for you`}>
            Less like this
          </button>
        ) : null}
        <button type="button" className={chip} disabled={disabled} onClick={() => setWrong(true)}>
          {target.kind === "assist" ? "Wrong assumption…" : "Ranked wrong…"}
        </button>
      </div>
      {hiding ? (
        <div id={hideId} className="jv-rise flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Hide from your Home:</span>
          {HIDE_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              className={cx(chip, "bg-surface-2")}
              disabled={disabled}
              onClick={() => {
                setHiding(false);
                send("not_now", { snoozeUntil: c.until(new Date()).toISOString() });
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      {!canHide ? <p className="text-xs text-muted">Safety alerts can’t be hidden or ranked lower.</p> : null}
      <Dialog
        open={wrong}
        onClose={() => setWrong(false)}
        title={target.kind === "assist" ? "What did Jarvis get wrong?" : "Why is this ranked wrong?"}
        description={
          target.kind === "assist"
            ? "The suggestion stays hidden until its data changes. Your note is saved for you (and for Hermes when you ask it to tune Home)."
            : "This stays out of Now until it changes. Nothing changes in its source."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setWrong(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={fb.isPending}
              disabled={!online}
              onClick={() => {
                send("wrong_assumption", { correction });
                setWrong(false);
                setCorrection("");
              }}
            >
              Send
            </Button>
          </>
        }
      >
        <Field id={`${hideId}-why`} label="Correction (optional)" hint={`${correction.length}/500`}>
          <textarea
            id={`${hideId}-why`}
            data-autofocus
            maxLength={500}
            rows={3}
            className={inputCls}
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder={target.kind === "assist" ? "e.g. That date is wrong, it's in March" : "e.g. Not urgent, it can wait until spring"}
          />
        </Field>
      </Dialog>
    </div>
  );
}
