"use client";

import { useQuery } from "@tanstack/react-query";
import { useAgentRuns } from "@/components/agents/AgentRuns";
import { Button, ButtonLink, useNow } from "@/components/ui";
import { Banner } from "@/components/ui/kit";
import { api } from "@/lib/client/api";
import type { DecisionsResponse } from "@/lib/decisions";
import { decisionHref } from "@/lib/decision-route";
import { selectEscalation } from "@/lib/item-escalation";

export function EscalationBanner({ itemId, onAskAgain }: { itemId: string; onAskAgain?: () => void }) {
  const decisions = useQuery({
    queryKey: ["work", "decisions"],
    queryFn: () => api.get<DecisionsResponse>("/api/work/decisions"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const runs = useAgentRuns();
  const escalation = selectEscalation(itemId, decisions.data?.entries ?? [], runs.data?.items[itemId], useNow());
  if (!escalation) return null;
  const question =
    escalation.kind === "decision"
      ? escalation.decision.question
      : escalation.kind === "run"
        ? `${escalation.stalled ? "Stalled" : "Failed"}: ${escalation.run.title}`
        : "A run failed. Review it before trying again.";
  const session = escalation.kind === "run" ? escalation.run.hermesSessionId : escalation.kind === "failed" ? escalation.sessionId : null;
  return (
    <div className="mt-2" data-testid="item-escalation">
      <Banner tone="wn">
        <div className="min-w-0">
          <p className="text-sm font-medium [overflow-wrap:anywhere]">
            {escalation.agent} needs you: {question}
          </p>
          <div className="mt-2 flex min-w-0 flex-wrap gap-2">
            {escalation.kind === "decision" ? (
              <>
                {escalation.decision.choices.slice(0, 3).map((choice) => (
                  <ButtonLink
                    size="sm"
                    key={choice}
                    href={`${decisionHref(escalation.decision)}?choice=${encodeURIComponent(choice)}`}
                    aria-label={`Review decision option: ${choice}`}
                  >
                    {choice}
                  </ButtonLink>
                ))}
                <ButtonLink size="sm" href={decisionHref(escalation.decision)}>
                  Open decision
                </ButtonLink>
              </>
            ) : (
              <>
                {session ? (
                  <ButtonLink size="sm" href={`/chat/${encodeURIComponent(session)}`} aria-label="Open escalated run">
                    Open run
                  </ButtonLink>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    aria-label="Open escalated run"
                    onClick={() => document.querySelector('[data-testid="item-agent-panel"]')?.scrollIntoView({ block: "center" })}
                  >
                    Open run
                  </Button>
                )}
                {onAskAgain ? (
                  <Button type="button" size="sm" onClick={onAskAgain}>
                    Ask again…
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </Banner>
    </div>
  );
}
