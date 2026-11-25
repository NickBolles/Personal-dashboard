"use client";

import { useState } from "react";
import { Banner, Button, Checkbox, Dialog, Pill } from "@/components/ui";
import { AGENT_SCOPES, AGENT_SCOPE_LABELS, RISKY_AGENT_SCOPES, normaliseScopes, scopeDiff, type AgentScope, type AgentTokenView } from "@/lib/agent-access";

/**
 * Settings → Agents → Agent access → ⋯ → Edit scopes. Two steps: pick scopes (risky ones flagged), then confirm
 * the diff. Saving keeps the same token (nothing to change in the agent's config). The server reads scopes on
 * every MCP call, so calls use them at once; the agent's tool list refreshes in its next new chat.
 */
export function EditScopesDialog({ token, onClose, onSave }: { token: AgentTokenView; onClose: () => void; onSave: (scopes: AgentScope[]) => Promise<void> }) {
  const [picked, setPicked] = useState<AgentScope[]>(normaliseScopes(token.scopes));
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [busy, setBusy] = useState(false);
  const next = normaliseScopes(picked);
  const { added, removed } = scopeDiff(token.scopes, next);
  const changed = added.length + removed.length > 0;
  const riskyAdded = added.filter((s) => RISKY_AGENT_SCOPES[s]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={step === "pick" ? "Edit scopes" : "Confirm scope change"}
      description={
        <span>
          {token.name} · <span className="jv-agent-chip">@{token.profile}</span> · <span className="font-mono">…{token.hint}</span>
        </span>
      }
      onClose={() => !busy && onClose()}
      footer={
        step === "pick" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!changed || !next.length} onClick={() => setStep("confirm")}>
              Review change
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStep("pick")}>
              Back
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Save scopes
            </Button>
          </>
        )
      }
    >
      {step === "pick" ? (
        <fieldset className="min-w-0" data-testid="edit-scopes">
          <legend className="sr-only">Scopes for {token.name}</legend>
          <div className="grid grid-cols-1 gap-1">
            {AGENT_SCOPES.map((s) => (
              <Checkbox
                key={s}
                checked={picked.includes(s)}
                onChange={(checked) => setPicked((cur) => (checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                label={
                  <span className="min-w-0">
                    <span className="font-semibold">{AGENT_SCOPE_LABELS[s].label}</span>
                    {RISKY_AGENT_SCOPES[s] ? (
                      <>
                        {" "}
                        <Pill tone="wn">Spends budget</Pill>
                      </>
                    ) : null}
                    <span className="block text-sm text-muted">{AGENT_SCOPE_LABELS[s].hint}</span>
                  </span>
                }
              />
            ))}
          </div>
          {!next.length ? <p className="mt-2 text-sm text-muted">Pick at least one scope. To cut access entirely, revoke the token.</p> : null}
        </fieldset>
      ) : (
        <div className="min-w-0 space-y-2 text-sm" data-testid="edit-scopes-confirm">
          {added.length ? (
            <div>
              <p className="eyebrow">Add</p>
              <ul className="mt-1 space-y-0.5" aria-label="Scopes to add">
                {added.map((s) => (
                  <li key={s}>
                    + <span className="font-semibold">{AGENT_SCOPE_LABELS[s].label}</span> <span className="font-mono text-xs text-muted">{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {removed.length ? (
            <div>
              <p className="eyebrow">Remove</p>
              <ul className="mt-1 space-y-0.5" aria-label="Scopes to remove">
                {removed.map((s) => (
                  <li key={s}>
                    − <span className="font-semibold">{AGENT_SCOPE_LABELS[s].label}</span> <span className="font-mono text-xs text-muted">{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {riskyAdded.length ? <Banner tone="wn">{riskyAdded.map((s) => RISKY_AGENT_SCOPES[s]).join(". ")}.</Banner> : null}
          <p className="text-muted">
            Same token, so nothing changes in the agent&apos;s config. Its calls use the new scopes right away; new tools show up in its next new chat.
          </p>
        </div>
      )}
    </Dialog>
  );
}
