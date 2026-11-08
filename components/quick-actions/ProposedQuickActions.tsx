"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { inputCls } from "@/components/ui/legacy";
import type { QuickAction } from "@/lib/quick-actions";
import { useQuickActions, useQuickActionWrite } from "./useQuickActions";
import "./quick-actions.css";

function Proposal({ action, primary }: { action: QuickAction; primary: boolean }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(action.label);
  const [prompt, setPrompt] = useState(action.prompt);
  const { write } = useQuickActionWrite();
  return (
    <div className="qa-proposal min-w-0 rounded-lg border border-dashed border-[var(--aib)] bg-[var(--ais)] p-2" data-testid="quick-action-proposal">
      <p className="text-xs font-semibold text-[var(--ai)]">Add quick action?</p>
      {editing ? (
        <div className="mt-1 grid min-w-0 gap-1">
          <input className={inputCls} aria-label="Proposed quick action label" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          <textarea
            className={inputCls}
            aria-label="Proposed quick action prompt"
            maxLength={2000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
      ) : (
        <>
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{label}</p>
          <p className="line-clamp-3 text-xs text-muted [overflow-wrap:anywhere]">{prompt}</p>
        </>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        <Button
          className="qa-hit"
          variant={primary ? "primary" : "secondary"}
          disabled={write.isPending || !label.trim() || !prompt.trim()}
          onClick={() =>
            write.mutate(
              { path: `/api/quick-actions/${action.id}/accept`, body: { label, prompt }, message: "Added" },
              { onSuccess: (r) => window.dispatchEvent(new CustomEvent("jarvis:quick-action-added", { detail: { opId: r.opId } })) },
            )
          }
        >
          Add
        </Button>
        <Button className="qa-hit" variant="ghost" disabled={write.isPending} onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel edit" : "Edit"}
        </Button>
        <Button className="qa-hit" variant="ghost" disabled={write.isPending} onClick={() => write.mutate({ path: `/api/quick-actions/${action.id}/dismiss` })}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
export function ProposedQuickActions() {
  const { data } = useQuickActions();
  const actions = (data?.actions ?? []).filter((a) => a.status === "proposed");
  return actions.length ? (
    <div className="qa-root grid max-h-[30dvh] min-w-0 shrink-0 gap-2 overflow-y-auto px-3 py-2">
      {actions.map((a, i) => (
        <Proposal key={a.id} action={a} primary={i === 0} />
      ))}
    </div>
  ) : null;
}
