"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { AgentResolution } from "@/lib/agents";
import { AgentChip } from "./AgentChip";

/** Area/project/item pages: which Hermes agent answers new chats and AI actions here. Hidden when nothing sets an agent. */
export function NodeAgentChip({ nodeId, version }: { nodeId: string; version?: string }) {
  const q = useQuery({
    queryKey: ["agents", "resolve", nodeId, version ?? ""],
    queryFn: () => api.get<AgentResolution>(`/api/agents/resolve?nodeId=${encodeURIComponent(nodeId)}`),
    staleTime: 60_000,
  });
  if (!q.data?.requested) return null;
  return <AgentChip agent={q.data} prefix="Answers here" testId="node-agent-chip" />;
}
