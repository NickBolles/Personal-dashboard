"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest } from "@/lib/hermes";
import { Button } from "@/components/ui";
import { AgentMark } from "@/components/brand/AgentMark";

type Choice = ApprovalRequest["choices"][number];

/** Seconds an approval can be undone before it is sent (client-side delay). */
export const APPROVE_UNDO_SECONDS = 8;

const LABEL: Record<Choice, string> = { once: "Approve once", session: "Approve for this session", always: "Always allow", deny: "Deny" };

/**
 * Hermes approval prompt: agent, exact command, why, then Approve / Deny.
 * Approvals wait 8 s with Undo (or "Send now") before the POST; a deny is
 * sent at once. If the prompt goes away (expired/withdrawn → the card
 * unmounts) or a new request replaces it, the pending timer is dropped, so
 * it never auto-approves.
 */
export function ApprovalCard({
  approval,
  agent,
  onAnswer,
  headingId = "approval-h",
}: {
  approval: ApprovalRequest;
  agent?: string | null;
  onAnswer: (c: Choice) => Promise<void> | void;
  headingId?: string;
}) {
  const [busy, setBusy] = useState<Choice>();
  const [pending, setPending] = useState<{ choice: Choice; left: number; requestId?: string }>();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const name = agent || "Hermes";
  // Identity of the prompt; falls back to its content when Hermes sends no id.
  const reqKey = approval.requestId ?? `${approval.command ?? ""}\u0000${approval.description ?? ""}`;

  const clear = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);

  const send = useCallback(
    async (c: Choice) => {
      clear();
      setPending(undefined);
      setBusy(c);
      try {
        await onAnswer(c);
      } finally {
        setBusy(undefined);
      }
    },
    [onAnswer],
  );

  // A pending approval only applies to the request it was made for.
  const live = pending && pending.requestId === reqKey ? pending : undefined;

  // Latest values for the countdown callback (it outlives renders).
  const latest = useRef({ send, requestId: reqKey });
  useEffect(() => {
    latest.current = { send, requestId: reqKey };
  });

  const choose = (c: Choice) => {
    if (c === "deny") return void send(c);
    clear();
    const requestId = reqKey;
    let left = APPROVE_UNDO_SECONDS;
    setPending({ choice: c, left, requestId });
    timer.current = setInterval(() => {
      // Withdrawn/replaced prompt: drop the pending approval, never auto-approve.
      if (latest.current.requestId !== requestId) return clear();
      left -= 1;
      if (left <= 0) return void latest.current.send(c);
      setPending({ choice: c, left, requestId });
    }, 1000);
  };

  const primary: Choice | undefined = approval.choices.includes("once") ? "once" : approval.choices.find((c) => c !== "deny");

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="appr"
      data-testid="approval-card"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && primary && !live && !busy) {
          e.preventDefault();
          choose(primary);
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentMark name={name} size={18} busy={Boolean(live || busy)} />
        <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold">
          {name} needs your approval
        </h2>
        <span className="chip ml-auto shrink-0" data-tone="warn">
          Approval
        </span>
      </div>
      {approval.description ? <p className="mt-1.5 text-sm text-muted">{approval.description}</p> : null}
      {approval.command ? (
        <pre className="appr-cmd" aria-label="Command" tabIndex={0}>
          {approval.command}
        </pre>
      ) : null}
      {live ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2" role="status">
          <span className="text-sm">
            {LABEL[live.choice]} in <span className="tabular-nums">{live.left}</span>s
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              clear();
              setPending(undefined);
            }}
          >
            Undo
          </Button>
          <Button size="sm" variant="primary" onClick={() => void send(live.choice)}>
            Send now
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {approval.choices.map((c) => (
            <Button
              key={c}
              size="sm"
              variant={c === "deny" ? "danger" : c === primary ? "primary" : "secondary"}
              busy={busy === c}
              disabled={Boolean(busy)}
              onClick={() => choose(c)}
            >
              {LABEL[c]}
            </Button>
          ))}
          {primary ? <span className="hidden text-xs text-muted dense:inline">⌘⏎ approves</span> : null}
        </div>
      )}
    </div>
  );
}
