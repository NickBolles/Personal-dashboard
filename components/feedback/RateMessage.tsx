"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import { Dialog, cx, inputCls, useToast } from "@/components/ui";
import { Button } from "@/components/ui/kit";
import { ThumbDownIcon, ThumbUpIcon } from "@/components/icons";
import {
  FEEDBACK_NOTE_MAX,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_LABELS,
  excerptOf,
  fixPrompt,
  type Feedback,
  type FeedbackList,
  type FeedbackReason,
  type FeedbackSurface,
} from "@/lib/feedback";

export const feedbackKey = (sessionId: string) => ["feedback", "session", sessionId] as const;

/** All ratings for one conversation (one request per open conversation, shared by every message). */
export function useSessionFeedback(sessionId: string | null | undefined, enabled = true) {
  const { can } = useAccess();
  return useQuery({
    queryKey: feedbackKey(sessionId ?? ""),
    queryFn: () => api.get<FeedbackList>(`/api/feedback?sessionId=${encodeURIComponent(sessionId!)}`),
    enabled: enabled && !!sessionId && can("hermes.chat"),
    staleTime: 60_000,
  });
}

type Saved = Pick<Feedback, "rating" | "reasons" | "note"> | null;

/**
 * 👍 / 👎 for one assistant reply. 👍 saves in one tap; 👎 opens "What went
 * wrong?" (reason chips + note) with an optional confirmed "Ask to fix" that
 * sends a correction prompt into the same conversation. Every save offers Undo.
 */
export function RateMessage({
  sessionId,
  messageId,
  surface,
  text,
  tools,
  model,
  who = "reply",
  onAskFix,
  className,
}: {
  sessionId: string;
  messageId: string;
  surface: FeedbackSurface;
  /** the rated reply's text (an excerpt is stored) */
  text: string;
  tools?: string[];
  model?: string | null;
  /** accessible name of the rated message ("Hermes' message") */
  who?: string;
  /** sends the fix prompt into the same conversation; resolves true when sent */
  onAskFix?: (prompt: string) => Promise<boolean>;
  className?: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useSessionFeedback(sessionId);
  const current = list.data?.entries.find((e) => e.messageId === messageId) ?? null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ label: string; prev: Saved; id: number } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["feedback"] });

  const save = async (v: { rating: "up" | "down"; reasons?: FeedbackReason[]; note?: string }) => {
    const r = await api.post<{ feedback: Feedback }>("/api/feedback", {
      sessionId,
      messageId,
      surface,
      rating: v.rating,
      reasons: v.reasons ?? [],
      note: v.note ?? "",
      text: text.slice(0, 50_000),
      ...(model ? { model } : {}),
      tools: (tools ?? []).slice(0, 50),
    });
    await refresh();
    return r.feedback;
  };
  const restore = async (prev: Saved, id: string | undefined) => {
    if (prev) await save(prev);
    else if (id) await api.del(`/api/feedback/${encodeURIComponent(id)}`);
    await refresh();
  };
  const prevOf = (): Saved => (current ? { rating: current.rating, reasons: current.reasons, note: current.note } : null);

  const thumbUp = async () => {
    if (busy) return;
    setBusy(true);
    const prev = prevOf();
    try {
      if (current?.rating === "up") {
        await api.del(`/api/feedback/${encodeURIComponent(current.id)}`);
        await refresh();
        setUndo({ label: "Rating removed", prev, id: Date.now() });
      } else {
        await save({ rating: "up" });
        setUndo({ label: "Rated good", prev, id: Date.now() });
      }
    } catch (e) {
      toast(`Not saved: ${(e as Error).message}`, "danger");
    } finally {
      setBusy(false);
    }
  };

  const label = `${current?.rating === "up" ? "Rated good" : "Good response"}: ${who}`;
  const downLabel = `${current?.rating === "down" ? "Rated bad" : "Bad response"}: ${who}`;
  return (
    <>
      <button
        type="button"
        className={cx(btnCls, current?.rating === "up" && "text-ok", className)}
        aria-label={label}
        title="Good response"
        aria-pressed={current?.rating === "up"}
        disabled={busy}
        onClick={() => void thumbUp()}
        data-testid="rate-up"
      >
        <ThumbUpIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cx(btnCls, current?.rating === "down" && "text-danger", className)}
        aria-label={downLabel}
        title="Bad response"
        aria-pressed={current?.rating === "down"}
        aria-haspopup="dialog"
        disabled={busy}
        onClick={() => setOpen(true)}
        data-testid="rate-down"
      >
        <ThumbDownIcon className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <RateDialog
          current={current}
          excerpt={excerptOf(text, 240)}
          canFix={!!onAskFix}
          onClose={() => setOpen(false)}
          onSave={async (v, fix) => {
            const prev = prevOf();
            const fb = await save({ rating: "down", ...v });
            if (fix && onAskFix) {
              const sent = await onAskFix(fix);
              if (!sent) return false;
              await api.patch(`/api/feedback/${encodeURIComponent(fb.id)}`, { fixRequested: true });
              await refresh();
              toast("Asked to fix", "ok");
            } else setUndo({ label: "Feedback saved", prev, id: Date.now() });
            return true;
          }}
          onRemove={async () => {
            if (!current) return;
            const prev = prevOf();
            await api.del(`/api/feedback/${encodeURIComponent(current.id)}`);
            await refresh();
            setUndo({ label: "Rating removed", prev, id: Date.now() });
          }}
        />
      ) : null}
      {undo ? (
        <UndoStrip
          key={undo.id}
          label={undo.label}
          onDone={() => setUndo(null)}
          onUndo={async () => {
            const id = (
              await qc.fetchQuery({
                queryKey: feedbackKey(sessionId),
                queryFn: () => api.get<FeedbackList>(`/api/feedback?sessionId=${encodeURIComponent(sessionId)}`),
              })
            ).entries.find((e) => e.messageId === messageId)?.id;
            await restore(undo.prev, id);
          }}
        />
      ) : null}
    </>
  );
}

const btnCls =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-text aria-pressed:bg-surface-2 sm:min-h-8 sm:min-w-8 dense:min-h-7 dense:min-w-7 disabled:opacity-50";

function RateDialog({
  current,
  excerpt,
  canFix,
  onClose,
  onSave,
  onRemove,
}: {
  current: Feedback | null;
  excerpt: string;
  canFix: boolean;
  onClose: () => void;
  onSave: (v: { reasons: FeedbackReason[]; note: string }, fixPrompt?: string) => Promise<boolean>;
  onRemove: () => Promise<void>;
}) {
  const { toast } = useToast();
  const noteId = useId();
  const fixId = useId();
  const [reasons, setReasons] = useState<FeedbackReason[]>(current?.rating === "down" ? current.reasons : []);
  const [note, setNote] = useState(current?.rating === "down" ? current.note : "");
  const [step, setStep] = useState<"rate" | "fix">("rate");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (r: FeedbackReason) => setReasons((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));
  const run = async (fn: () => Promise<boolean | void>) => {
    setBusy(true);
    try {
      if ((await fn()) !== false) onClose();
    } catch (e) {
      toast(`Not saved: ${(e as Error).message}`, "danger");
    } finally {
      setBusy(false);
    }
  };
  if (step === "fix")
    return (
      <Dialog
        open
        onClose={onClose}
        title="Ask to fix"
        description="Sends this to the same agent in this conversation. Edit it first if you like."
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep("rate")} disabled={busy}>
              Back
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!prompt.trim()}
              onClick={() => void run(() => onSave({ reasons, note }, prompt.trim()))}
              data-testid="feedback-send-fix"
            >
              Send
            </Button>
          </>
        }
      >
        <label htmlFor={fixId} className="sr-only">
          Message to send
        </label>
        <textarea
          id={fixId}
          className={cx(inputCls, "text-sm")}
          rows={7}
          value={prompt}
          maxLength={4000}
          onChange={(e) => setPrompt(e.target.value)}
          data-autofocus
        />
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title="What went wrong?"
      description={excerpt ? <span className="line-clamp-2">“{excerpt}”</span> : undefined}
      footer={
        <>
          {current?.rating === "down" ? (
            <Button variant="ghost" disabled={busy} onClick={() => void run(onRemove)} className="mr-auto">
              Remove rating
            </Button>
          ) : null}
          {canFix ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setPrompt(fixPrompt({ reasons, note: note.trim(), excerpt }));
                setStep("fix");
              }}
              data-testid="feedback-ask-fix"
            >
              Ask to fix…
            </Button>
          ) : null}
          <Button variant="primary" loading={busy} onClick={() => void run(() => onSave({ reasons, note: note.trim() }))} data-testid="feedback-save">
            Save
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">Reasons</legend>
        <div className="flex flex-wrap gap-1.5">
          {FEEDBACK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reasons.includes(r)}
              onClick={() => toggle(r)}
              className="k-chip inline-flex min-h-9 items-center rounded-full border border-line px-3 text-sm aria-pressed:border-accent aria-pressed:bg-[var(--acs,transparent)] aria-pressed:text-accent sm:min-h-8"
            >
              {FEEDBACK_REASON_LABELS[r]}
            </button>
          ))}
        </div>
      </fieldset>
      <label htmlFor={noteId} className="mt-3 mb-1 block text-xs font-medium text-muted">
        Note (optional)
      </label>
      <textarea
        id={noteId}
        className={cx(inputCls, "text-sm")}
        rows={3}
        value={note}
        maxLength={FEEDBACK_NOTE_MAX}
        placeholder="What should it have said or done?"
        onChange={(e) => setNote(e.target.value)}
      />
    </Dialog>
  );
}

export const FEEDBACK_UNDO_MS = 8000;

/** "Saved · Undo" strip (same placement as the work UndoBar) for non-item undo. */
export function UndoStrip({ label, onUndo, onDone }: { label: string; onUndo: () => Promise<void>; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  useEffect(() => {
    const t = setTimeout(() => doneRef.current(), FEEDBACK_UNDO_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(144px+env(safe-area-inset-bottom))] z-[61] flex justify-center px-4 lg:bottom-40">
      <div
        role="status"
        className="jv-undo pointer-events-auto relative flex max-w-md items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface px-4 py-2 text-sm shadow-lg"
        style={{ "--undo-ms": `${FEEDBACK_UNDO_MS}ms` } as CSSProperties}
      >
        <span>{label}</span>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onUndo();
              toast("Undone", "ok");
              onDone();
            } catch (e) {
              toast(`Couldn't undo: ${(e as Error).message}`, "danger");
            } finally {
              setBusy(false);
            }
          }}
        >
          Undo
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} aria-label="Dismiss">
          ✕
        </Button>
      </div>
    </div>
  );
}
