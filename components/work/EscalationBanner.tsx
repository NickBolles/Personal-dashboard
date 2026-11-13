"use client";

import { useAgentRuns } from "@/components/agents/AgentRuns";
import { useNow, Banner, Button, ButtonLink } from "@/components/ui";
import { ItemDecisions } from "@/components/decisions/DecisionBlock";
import { useInboxDecisions } from "@/components/decisions/useAnswerDecision";
import { selectEscalation } from "@/lib/item-escalation";
import { WORK_WORD } from "@/lib/work-words";

/**
 * What an item needs from the owner, at the top of its page: every open decision as the shared decision card
 * (answered in place, components/decisions), or, when no agent is asking, the run that failed or stalled.
 */
export function EscalationBanner({ itemId, onAskAgain }: { itemId: string; onAskAgain?: () => void }) {
  const decisions = useInboxDecisions();
  const runs = useAgentRuns();
  const escalation = selectEscalation(itemId, decisions.data?.entries ?? [], runs.data?.items[itemId], useNow());
  // An agent's question wins over run trouble: the cards say it; the run banner waits.
  const trouble = escalation && escalation.kind !== "decision" ? escalation : null;
  const session = trouble ? (trouble.kind === "run" ? trouble.run.hermesSessionId : trouble.sessionId) : null;
  return (
    <>
      <ItemDecisions itemId={itemId} className="mt-2" />
      {trouble ? (
        <div className="mt-2" data-testid="item-escalation">
          <Banner tone="wn">
            <div className="min-w-0">
              <p className="text-sm font-medium wrap-anywhere">
                {trouble.agent} needs you:{" "}
                {trouble.kind === "run"
                  ? `${WORK_WORD[trouble.stalled ? "stalled" : "failed"]}: ${trouble.run.title}`
                  : "A run failed. Review it before trying again."}
              </p>
              <div className="mt-2 flex min-w-0 flex-wrap gap-2">
                {session ? (
                  <ButtonLink size="sm" href={`/chat/${encodeURIComponent(session)}`} aria-label="Open escalated run">
                    Open run
                  </ButtonLink>
                ) : (
                  <Button
                    size="sm"
                    aria-label="Open escalated run"
                    onClick={() => document.querySelector('[data-testid="item-agent-panel"]')?.scrollIntoView({ block: "center" })}
                  >
                    Open run
                  </Button>
                )}
                {onAskAgain ? (
                  <Button size="sm" onClick={onAskAgain}>
                    Ask again…
                  </Button>
                ) : null}
              </div>
            </div>
          </Banner>
        </div>
      ) : null}
    </>
  );
}
