"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { AgentResolution } from "@/lib/agents";
import { AgentChip } from "./AgentChip";

/** Which Hermes agent answers new chats and AI actions on an area / project / item (undefined until it is known). */
export function useNodeAgent(nodeId: string, version?: string, enabled = true) {
  return useQuery({
    queryKey: ["agents", "resolve", nodeId, version ?? ""],
    queryFn: () => api.get<AgentResolution>(`/api/agents/resolve?nodeId=${encodeURIComponent(nodeId)}`),
    staleTime: 60_000,
    enabled,
  }).data;
}

/** Area/project/item pages: which Hermes agent answers new chats and AI actions here. Hidden when nothing sets an agent. */
export function NodeAgentChip({ nodeId, version }: { nodeId: string; version?: string }) {
  const agent = useNodeAgent(nodeId, version);
  if (!agent?.requested) return null;
  return <AgentChip agent={agent} prefix="Answers here" testId="node-agent-chip" />;
}
