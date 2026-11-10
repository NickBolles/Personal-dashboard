"use client";

import { useEffect, useRef, useState } from "react";
import type { ClarifyRequest } from "@/lib/hermes";
import { Button, inputCls } from "@/components/ui/legacy";
import { AgentMark } from "@/components/brand/AgentMark";

/**
 * A Hermes clarify question: one tap on a choice sends it as the answer; "Other" takes a typed
 * answer. Multi-select questions toggle choices, then send them together. Nothing is sent
 * without a tap, and a failed send keeps the card with Retry.
 */
export function ClarifyCard({
  clarify,
  agent,
  onAnswer,
}: {
  clarify: ClarifyRequest;
  agent?: string | null;
  onAnswer: (answer: string) => Promise<void> | void;
}) {
  const name = agent || "Hermes";
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<{ answer: string; detail: string; requestId: string }>();
  const [other, setOther] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const failure = failed && failed.requestId === clarify.requestId ? failed : undefined;
  const headingId = `clarify-h-${clarify.requestId.replace(/\W+/g, "-")}`;
  const ref = useRef<HTMLElement>(null);
  // #185: bring the question clear of the sticky header and composer (scroll-margin in globals.css).
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [clarify.requestId]);

  const send = async (answer: string) => {
    const a = answer.trim();
    if (!a || busy) return;
    setBusy(a);
    setFailed(undefined);
    const requestId = clarify.requestId;
    try {
      await onAnswer(a);
    } catch (err) {
      setFailed({ answer: a, detail: err instanceof Error ? err.message : String(err), requestId });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section ref={ref} role="group" aria-labelledby={headingId} className="clarify-card" data-testid="clarify-card">
      <div className="flex min-w-0 items-start gap-2">
        <AgentMark className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted">{name} asks</p>
          <h3 id={headingId} className="text-[14.5px] leading-snug font-semibold [overflow-wrap:anywhere]">
            {clarify.question}
          </h3>
        </div>
      </div>
      {clarify.choices.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5" role={clarify.multiSelect ? "group" : undefined} aria-label={clarify.multiSelect ? "Choices" : undefined}>
          {clarify.choices.map((c) =>
            clarify.multiSelect ? (
              <button
                key={c}
                type="button"
                className="clarify-choice"
                aria-pressed={picked.includes(c)}
                onClick={() => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}
              >
                {c}
              </button>
            ) : (
              <button
                key={c}
                type="button"
                className="clarify-choice"
                disabled={Boolean(busy)}
                aria-busy={busy === c || undefined}
                onClick={() => void send(c)}
              >
                {c}
              </button>
            ),
          )}
          {clarify.multiSelect ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="clarify-send"
              disabled={!picked.length || Boolean(busy)}
              busy={Boolean(busy)}
              onClick={() => void send(picked.join(", "))}
            >
              Send {picked.length ? picked.length : ""}
            </Button>
          ) : null}
        </div>
      ) : null}
      <form
        className="clarify-other mt-2 flex min-w-0 flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(other);
        }}
      >
        <input
          className={`${inputCls} min-w-0 flex-1 basis-40`}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder={clarify.choices.length ? "Other answer…" : "Your answer…"}
          aria-label={clarify.choices.length ? "Other answer" : "Your answer"}
          maxLength={4000}
        />
        {/* With choices above (the one-tap answers) this is a quiet text action; alone, it is the card's one primary. */}
        <Button
          type="submit"
          size="sm"
          variant={clarify.choices.length ? "ghost" : "primary"}
          className={clarify.choices.length ? "clarify-answer" : undefined}
          disabled={!other.trim() || Boolean(busy)}
        >
          Answer
        </Button>
      </form>
      {failure ? (
        <div className="mt-2 text-sm text-danger" role="alert">
          Couldn&apos;t send your answer.{" "}
          <button type="button" className="underline" onClick={() => void send(failure.answer)}>
            Retry
          </button>
          <details className="mt-1 text-xs text-muted">
            <summary className="cursor-pointer">Details</summary>
            {failure.detail}
          </details>
        </div>
      ) : null}
    </section>
  );
}
