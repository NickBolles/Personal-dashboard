import { agentOf } from "@/lib/activity";

/**
 * #180 "by @profile" chip: a change an agent token made on the owner's behalf (Jarvis MCP,
 * docs/agent-tools.md). Only rendered from recorded actor data (work_events.via, work_items
 * created_via/updated_via); never inferred.
 */
export function AgentChip({ profile, verb }: { profile: string; verb?: "created" | "updated" }) {
  return (
    <span className="jv-agent-chip" data-testid="agent-chip" title={`${verb ? `${verb[0]!.toUpperCase()}${verb.slice(1)} ` : ""}by the ${profile} agent`}>
      {verb ? `${verb} ` : ""}by @{profile}
    </span>
  );
}

/** The item's latest agent attribution (update wins over create), or null for the person's own items. */
export function itemAgentChip(i: { createdVia?: string | null; updatedVia?: string | null }) {
  const updated = agentOf(i.updatedVia);
  if (updated) return <AgentChip profile={updated} verb="updated" />;
  const created = agentOf(i.createdVia);
  return created ? <AgentChip profile={created} verb="created" /> : null;
}
