"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { answerComplete, answerDraftKey, answerPayload, type AnswerQuestion, type AnswerValues } from "@/lib/jarvis-ui/answers";
import "./answers.css";
import { SmartReply } from "./live";

export const BatchedAnswers = createContext(false);
type Draft = { source: string; values: AnswerValues; payload?: string; key?: string; sent?: boolean };

export function AnswerBatch({ questions, session, source }: { questions: AnswerQuestion[]; session: string; source: string }) {
  const reply = useContext(SmartReply);
  const storageKey = answerDraftKey(session, source);
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Draft | null;
      if (saved?.source === source) return saved;
    } catch {
      /* private browsing/storage unavailable */
    }
    return { source, values: {} };
  });
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const refsKey = JSON.stringify(questions.flatMap((q) => (q.ref ? [q.ref] : [])));
  const [checking, setChecking] = useState(refsKey !== "[]");
  const [stale, setStale] = useState<string[]>([]);
  useEffect(() => {
    const refs = JSON.parse(refsKey) as string[];
    if (!refs.length) return;
    let cancelled = false;
    void api
      .get<{ decisions: { ref: string; state: string }[] }>("/api/coordinator/decisions")
      .then((current) => {
        if (!cancelled) setStale(refs.filter((ref) => !current.decisions.some((d) => d.ref === ref && d.state === "open")));
      })
      .catch(() => {
        if (!cancelled) setStale(refs);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refsKey]);
  const save = (next: Draft) => {
    setDraft(next);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* explained below */
    }
  };
  const missing = questions.filter((q) => !answerComplete(q, draft.values[q.id]));
  const locked = busy || !!draft.payload || !!draft.sent;
  const text = draft.payload ?? `Reply to conversation ${session}, response ${source.split("\n")[0]}\n\n${answerPayload(questions, draft.values)}`;
  const update = (id: string, choice: string, other?: string) => {
    save({ source, values: { ...draft.values, [id]: { choice, other } } });
    setReview(false);
    setError("");
  };
  const submit = async () => {
    if (inFlight.current || draft.sent || missing.length || checking || stale.length || !reply) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const refs = questions.flatMap((q) => (q.ref ? [q.ref] : []));
      if (refs.length) {
        const current = await api.get<{ decisions: { ref: string; state: string }[] }>("/api/coordinator/decisions");
        const closed = refs.filter((ref) => !current.decisions.some((d) => d.ref === ref && d.state === "open"));
        if (closed.length) {
          setStale(closed);
          throw new Error(`${closed.join(", ")} is closed or unavailable. Ask for an updated set of questions; nothing was sent.`);
        }
      }
      const attempt = { ...draft, payload: text, key: draft.key ?? newIdempotencyKey("answers") };
      save(attempt);
      if (!(await reply(text, attempt.key)))
        throw new Error("Send not confirmed. Your selections are kept. Retry uses the same message key; do not send it manually.");
      save({ ...attempt, sent: true });
      setReview(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="answer-batch min-w-0 space-y-3 rounded-lg border border-line p-3"
      data-testid="answer-batch"
      aria-label="Your choices"
      data-density="sleek"
    >
      <div>
        <h3 className="text-sm font-semibold">Your choices</h3>
        <p className="text-xs text-muted">Select locally, then review one reply. No decisions or actions are committed.</p>
      </div>
      {questions.map((q) => (
        <fieldset
          key={q.id}
          disabled={!reply || locked || (!!q.ref && (checking || stale.includes(q.ref)))}
          className="min-w-0 space-y-1 border-b border-line pb-2"
        >
          <legend className="max-w-full text-sm font-medium break-words">
            {q.ref && !q.title.includes(q.ref) ? `${q.ref} · ` : ""}
            {q.title} <span className="text-xs text-muted">{q.required ? "Required" : "Optional"}</span>
          </legend>
          {q.context ? <p className="text-xs text-muted break-words">{q.context}</p> : null}
          {q.kind === "choice" ? (
            <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label={q.title}>
              {q.options.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant="secondary"
                  className="max-w-full whitespace-normal text-left break-words"
                  aria-pressed={draft.values[q.id]?.choice === o.id}
                  onClick={() => update(q.id, o.id)}
                >
                  {o.label}
                  {o.recommended ? " · Recommended" : ""}
                </Button>
              ))}
              {q.allowOther ? (
                <Button size="sm" variant="ghost" aria-pressed={draft.values[q.id]?.choice === "$other"} onClick={() => update(q.id, "$other", "")}>
                  Other
                </Button>
              ) : null}
            </div>
          ) : null}
          {q.kind === "text" || draft.values[q.id]?.choice === "$other" ? (
            <Input
              aria-label={`${q.title} response`}
              className="w-full min-w-0"
              maxLength={2000}
              value={draft.values[q.id]?.other ?? ""}
              onChange={(e) => update(q.id, q.kind === "text" ? "text" : "$other", e.target.value)}
            />
          ) : null}
          {q.options.find((o) => o.id === draft.values[q.id]?.choice)?.consequence ? (
            <p className="text-xs text-muted break-words">{q.options.find((o) => o.id === draft.values[q.id]?.choice)?.consequence}</p>
          ) : null}
          {!q.required ? (
            <Button size="sm" variant="ghost" aria-pressed={draft.values[q.id]?.choice === "$skip"} onClick={() => update(q.id, "$skip")}>
              Skip
            </Button>
          ) : null}
        </fieldset>
      ))}
      {review ? (
        <div className="min-w-0 space-y-2" role="region" aria-label="Review exact reply">
          <p className="text-xs text-muted">
            This exact text goes to this conversation. It does not answer Needs you, settle work or authorize any action. Actions still need their own
            confirmation.
          </p>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap text-xs break-words">{text}</pre>
        </div>
      ) : null}
      <p role="status" className="text-xs text-muted break-words">
        {draft.sent
          ? "Sent as one reply to this conversation."
          : error ||
            (checking
              ? "Checking current decisions…"
              : stale.length
                ? `${stale.join(", ")} is closed or unavailable. Ask for updated questions; nothing was sent.`
                : missing.length
                  ? `Choose required answers: ${missing.map((q) => q.title).join("; ")}`
                  : "Ready to review.")}
      </p>
      {!draft.sent ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            className="max-w-full whitespace-normal"
            disabled={!reply || !!missing.length || text.length > 8000 || checking || !!stale.length}
            loading={busy}
            onClick={() => (review ? void submit() : setReview(true))}
          >
            {review ? (draft.payload ? "Retry same reply" : "Confirm send reply") : "Submit choices"}
          </Button>
          {!locked ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                save({ source, values: {} });
                setReview(false);
                setError("");
              }}
            >
              Reset choices
            </Button>
          ) : null}
          {review && !locked ? (
            <Button size="sm" variant="ghost" onClick={() => setReview(false)}>
              Cancel review
            </Button>
          ) : null}
        </div>
      ) : null}
      {!reply ? <p className="text-xs text-muted">This view cannot send replies. Open the originating conversation.</p> : null}
      {text.length > 8000 ? <p className="text-xs text-muted">Reply exceeds 8,000 characters. Shorten your written answers.</p> : null}
      <p className="text-xs text-muted">
        Draft kept in this browser tab through reload when storage is available; closing the tab clears it. After a send attempt, retry the same reply before
        editing.
      </p>
    </section>
  );
}
