"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { isActiveExec, type ChatExecutionResponse } from "@/lib/chat-execution";
import { chatThings, executionAttentionKey, linkAttentionKey, type ChatThingsInput, type ThingsTab } from "@/lib/chat/things";

export function useChatThings(sessionId: string, input: Omit<ChatThingsInput, "execution" | "executionUnavailable" | "now" | "previous">) {
  const execution = useQuery({
    queryKey: ["chat-execution", sessionId],
    queryFn: async () => {
      const result = await api.get<ChatExecutionResponse>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/execution`);
      if (!Array.isArray(result.records) || !Array.isArray(result.sources)) throw new Error("Couldn't check background work");
      return result;
    },
    refetchInterval: (q) => (q.state.data?.records.some(isActiveExec) ? 20_000 : 60_000),
  });
  const [seen, setSeen] = useState<{ sessionId: string; keys: string[] }>({ sessionId, keys: [] });
  const [clock, setClock] = useState(0);
  const [history, setHistory] = useState<{ sessionId: string; line: ReturnType<typeof chatThings>["line"]; transition?: number }>();
  useEffect(() => {
    const tick = () => setClock(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const raw = chatThings({
    ...input,
    execution: execution.data,
    executionUnavailable: execution.isError,
    seen: seen.sessionId === sessionId ? seen.keys : [],
    now: clock,
  });
  const previous = history?.sessionId === sessionId ? history : undefined;
  const things = chatThings({
    ...input,
    execution: execution.data,
    executionUnavailable: execution.isError,
    seen: seen.sessionId === sessionId ? seen.keys : [],
    previous: previous?.line,
    transitionSince: previous?.transition ?? clock,
    now: clock,
  });
  const signature = JSON.stringify(things.line);
  const rawId = raw.line.id;
  useEffect(() => {
    // Keep the first observation of a downward transition, not a rolling timeout.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- priority hysteresis snapshot, not derived UI state
    setHistory((h) => ({ sessionId, line: JSON.parse(signature), transition: rawId !== JSON.parse(signature).id ? (h?.transition ?? clock) : undefined }));
  }, [signature, rawId, clock, sessionId]);
  const markSeen = (tab: ThingsTab) =>
    setSeen((previous) => ({
      sessionId,
      keys: [
        ...new Set([
          ...(previous.sessionId === sessionId ? previous.keys : []),
          ...(tab === "Running" ? (execution.data?.records.map(executionAttentionKey) ?? []) : []),
          ...(tab === "PRs" || tab === "Links" ? input.links.map(linkAttentionKey) : []),
          ...(tab === "Outline" ? ["workflow-step"] : []),
        ]),
      ],
    }));
  return { things, execution: execution.data, loading: execution.isPending, error: execution.isError, retry: () => void execution.refetch(), markSeen };
}
