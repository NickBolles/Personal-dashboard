import { AGENT_REASON_TEXT, agentChipLabel, type AgentResolution } from "@/lib/agents";

/**
 * "Who will answer" chip (composer, area pages). Accent = a routed Hermes
 * profile; neutral = the default profile, with the requested profile shown as a hint.
 */
export function AgentChip({ agent, prefix = "Agent", testId = "agent-chip" }: { agent: AgentResolution; prefix?: string; testId?: string }) {
  const label = agentChipLabel(agent);
  const why = AGENT_REASON_TEXT[agent.reason];
  return (
    <span className="chip relative" data-tone={agent.routed ? "accent" : undefined} title={why} data-testid={testId} data-routed={agent.routed ? "1" : "0"}>
      <span>{prefix}</span>
      <span aria-hidden="true">✦</span>
      {label}
      <span className="sr-only">. {why}</span>
    </span>
  );
}
