"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Input, Textarea } from "@/components/ui";
import { api, newIdempotencyKey } from "@/lib/client/api";
import { answerComplete, answerDraftKey, answerPayload, type AnswerQuestion, type AnswerValues } from "@/lib/jarvis-ui/answers";
import "./answers.css";
import { SmartReply } from "./live";

export const BatchedAnswers = createContext(false);
type Draft = { source: string; values: AnswerValues; edited?: string[]; payload?: string; key?: string; sent?: boolean };
// One tab can show this exact response in both the chat page and coordinator rail.
const pendingBatches = new Set<string>();
const DRAFT_EVENT = "jarvis:answer-draft";

const subscribeHydration = () => () => undefined;
type BatchProps = { questions: AnswerQuestion[]; session: string; source: string };
/** Read tab storage only after hydration, so SSR cannot disagree with a restored selected/sent state. */
export function AnswerBatch(props: BatchProps) {
  const mounted = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false,
  );
  return mounted ? <AnswerBatchState {...props} /> : <p className="text-xs text-muted">Loading saved choices…</p>;
}
function AnswerBatchState({ questions, session, source }: BatchProps) {
  const reply = useContext(SmartReply);
  const storageKey = answerDraftKey(session, source);
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Draft | null;
      if (saved?.source === source) return saved;
    } catch {
      /* private browsing/storage unavailable */
    }
    return { source, values: Object.fromEntries(questions.filter((q) => q.proposed).map((q) => [q.id, q.proposed!])) };
  });
  const [busy, setBusy] = useState(() => pendingBatches.has(storageKey));
  const notify = (next?: Draft) => window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { storageKey, next, busy: pendingBatches.has(storageKey) } }));
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey: string; next?: Draft; busy: boolean }>).detail;
      if (detail.storageKey !== storageKey) return;
      if (detail.next) setDraft(detail.next);
      setBusy(detail.busy);
    };
    window.addEventListener(DRAFT_EVENT, receive);
    return () => window.removeEventListener(DRAFT_EVENT, receive);
  }, [storageKey]);
  const [error, setError] = useState("");
  const [showSent, setShowSent] = useState(false);
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
    notify(next);
  };
  const missing = questions.filter((q) => !answerComplete(q, draft.values[q.id]));
  const locked = busy || !!draft.payload || !!draft.sent;
  const text = draft.payload ?? `Reply to conversation ${session}, response ${source.split("\n")[0]}\n\n${answerPayload(questions, draft.values)}`;
  const update = (id: string, choice: string, other?: string) => {
    save({ source, values: { ...draft.values, [id]: { choice, other } }, edited: [...new Set([...(draft.edited ?? []), id])] });
    setError("");
  };
  const submit = async () => {
    if (inFlight.current || pendingBatches.has(storageKey) || draft.sent || missing.length || text.length > 50_000 || checking || stale.length || !reply)
      return;
    inFlight.current = true;
    pendingBatches.add(storageKey);
    notify();
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      pendingBatches.delete(storageKey);
      notify();
      setBusy(false);
    }
  };
  return (
    <section className="answer-batch min-w-0" data-testid="answer-batch" aria-label="Your choices" data-density="sleek">
      {(!draft.sent || showSent) &&
        questions.map((q, index) => (
          <fieldset key={q.id} disabled={!reply || locked || (!!q.ref && (checking || stale.includes(q.ref)))} className="answer-question min-w-0">
            <legend className="max-w-full text-sm font-medium break-words">
              {q.group && q.group !== questions[index - 1]?.group ? <span className="answer-group">{q.group}</span> : null}
              {q.ref && !q.title.includes(q.ref) ? `${q.ref} · ` : ""}
              {q.label ?? q.title} {q.required ? <span className="sr-only">Required</span> : <span className="answer-optional">Optional</span>}
            </legend>
            {q.context && q.context !== questions[index - 1]?.context ? <p className="answer-context">{q.context}</p> : null}
            {q.proposed && !draft.edited?.includes(q.id) && draft.values[q.id] ? <p className="text-xs text-ai">Proposed by Atlas · editable</p> : null}
            {q.kind === "choice" ? (
              <div className="answer-options" role="group" aria-label={q.title}>
                {q.options.map((o) => (
                  <Button
                    key={o.id}
                    size="sm"
                    variant="ghost"
                    className="max-w-full whitespace-normal text-left break-words"
                    aria-pressed={draft.values[q.id]?.choice === o.id}
                    onClick={() => update(q.id, o.id)}
                  >
                    {o.label}
                    {o.recommended ? <span className="answer-recommended">Suggested</span> : null}
                  </Button>
                ))}
                {q.allowOther ? (
                  <Button size="sm" variant="ghost" aria-pressed={draft.values[q.id]?.choice === "$other"} onClick={() => update(q.id, "$other", "")}>
                    Other
                  </Button>
                ) : null}
              </div>
            ) : null}
            {q.kind === "textarea" ? (
              <Textarea
                aria-label={`${q.title} response`}
                className="w-full min-w-0"
                rows={3}
                maxLength={2000}
                value={draft.values[q.id]?.other ?? ""}
                onChange={(e) => update(q.id, "text", e.target.value)}
              />
            ) : q.kind === "text" || draft.values[q.id]?.choice === "$other" ? (
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
      <p role="status" className="text-xs text-muted break-words">
        {draft.sent
          ? "Sent as one reply to this conversation."
          : error ||
            (checking
              ? "Checking current decisions…"
              : stale.length
                ? `${stale.join(", ")} is closed or unavailable. Ask for updated questions; nothing was sent.`
                : missing.length
                  ? `${questions.length - missing.length} of ${questions.length} ready`
                  : "One reply · no actions executed")}
      </p>
      {!draft.sent ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            className="max-w-full whitespace-normal"
            disabled={!reply || !!missing.length || text.length > 50_000 || checking || !!stale.length}
            loading={busy}
            onClick={() => void submit()}
          >
            {draft.payload ? "Retry same reply" : "Submit choices"}
          </Button>
          {!locked ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                save({ source, values: {} });
                setError("");
              }}
            >
              Reset choices
            </Button>
          ) : null}
        </div>
      ) : null}
      {draft.sent ? (
        <Button size="sm" variant="ghost" aria-expanded={showSent} onClick={() => setShowSent((value) => !value)}>
          {showSent ? "Hide choices" : "View choices"}
        </Button>
      ) : null}
      {!reply ? <p className="text-xs text-muted">This view cannot send replies. Open the originating conversation.</p> : null}
      {text.length > 50_000 ? (
        <p className="text-xs text-muted">Reply exceeds the chat limit of 50,000 characters. Shorten written answers or ask for a smaller set of questions.</p>
      ) : null}
    </section>
  );
}
