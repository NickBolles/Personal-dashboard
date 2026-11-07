"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { DecisionEntry } from "@/lib/decisions";
import { Button, ButtonLink, Dialog, ErrorNote, Field, inputCls } from "@/components/ui";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";

/** Same decision-answer endpoint as the inbox, with review before the local, undoable write. Posting to chat stays in its existing flow. */
export function DecisionAnswer({ entry, initialChoice = "" }: { entry: DecisionEntry; initialChoice?: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState(entry.choices.includes(initialChoice) ? initialChoice : "");
  const [confirm, setConfirm] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [op, setOp] = useState<UndoOp | null>(null);
  const answer = useMutation({
    mutationFn: () =>
      api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(entry.itemId!)}/decision`, { answer: text.trim(), postToConversation: false }),
    onSuccess: (result) => {
      setOp(result.op);
      setAnswered(true);
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ["work"] });
      void qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const conversation = entry.sessionId ?? entry.coordinatorSessionId;
  return (
    <>
      {answered ? (
        <div role="status" className="space-y-2">
          <p>Decision recorded. Nothing was settled or sent to a conversation.</p>
          {conversation ? (
            <ButtonLink href={`/chat/${encodeURIComponent(conversation)}`} size="sm">
              Open conversation
            </ButtonLink>
          ) : null}
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) setConfirm(true);
          }}
        >
          {entry.choices.length ? (
            <div role="group" aria-label="Decision options" className="flex min-w-0 flex-wrap gap-2">
              {entry.choices.map((choice) => (
                <Button
                  key={choice}
                  type="button"
                  size="sm"
                  aria-pressed={choice === text}
                  onClick={() => {
                    setText(choice);
                    setConfirm(true);
                  }}
                >
                  {choice}
                </Button>
              ))}
            </div>
          ) : null}
          <Field id="decision-answer" label="Your answer">
            <input id="decision-answer" className={inputCls} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            Answer…
          </Button>
        </form>
      )}
      <Dialog
        open={confirm}
        onClose={() => {
          if (!answer.isPending) setConfirm(false);
        }}
        title="Confirm decision"
        description="Records your answer on the item. Does not settle it or send a message."
        footer={
          <>
            <Button type="button" disabled={answer.isPending} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" busy={answer.isPending} onClick={() => answer.mutate()}>
              Record decision
            </Button>
          </>
        }
      >
        <p className="text-sm font-medium">{entry.question}</p>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">{text}</p>
        {answer.error ? <ErrorNote error={answer.error} retry={() => answer.mutate()} /> : null}
      </Dialog>
      {op ? <UndoBar key={op.id} op={op} onDone={() => setOp(null)} onUndone={() => setAnswered(false)} /> : null}
    </>
  );
}
